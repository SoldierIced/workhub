import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent, Probe, StartSessionRequest, WorkhubConfig } from '@workhub/core'
import { SignInFlow, SignInService, type SignInProcess, type SignInTerminal } from '../src/main/sign-in'
import { REMOTE_EVENTS, REMOTE_INVOKES, REMOTE_MESSAGES } from '../src/main/remote/allowlist'
import type { SignInEvent } from '../src/shared/sign-in-api'
import { parseSignInHash, signInHash } from '../src/shared/sign-in-api'

const POLL = 1000

/** A sign-in command the test drives: what it prints, when it exits, what was typed. */
function fakeProcess() {
  const on = { output: (_d: string) => undefined as void, exit: (_c: number) => undefined as void }
  const typed: string[] = []
  const proc: SignInProcess = { write: (d) => void typed.push(d), resize: () => undefined, kill: vi.fn(async () => on.exit(130)) }
  return {
    typed,
    proc,
    spawn: async (handlers: typeof on) => {
      Object.assign(on, handlers)
      return proc
    },
    print: (d: string) => on.output(d),
    exit: (code = 0) => on.exit(code)
  }
}

function flowWith(tool: 'claude' | 'github', check: () => Promise<boolean>) {
  const p = fakeProcess()
  const events: SignInEvent[] = []
  const opened: string[] = []
  const flow = new SignInFlow({ tool, accountName: '', spawn: p.spawn, check, emit: (e) => events.push(e), openUrl: (u) => opened.push(u), pollMs: POLL })
  return { flow, p, events, opened }
}

describe('SignInFlow (fake clock)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('checks the status on an interval while the command runs and turns signed in', async () => {
    let ready = false
    const check = vi.fn(async () => ready)
    const { flow } = flowWith('claude', check)
    expect((await flow.start()).phase).toBe('running')
    expect(check).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(POLL)
    expect(check).toHaveBeenCalledTimes(1)
    expect(flow.view().phase).toBe('running')
    await vi.advanceTimersByTimeAsync(POLL * 2)
    expect(check).toHaveBeenCalledTimes(3)
    ready = true
    await vi.advanceTimersByTimeAsync(POLL)
    expect(flow.view().phase).toBe('signedIn')
    // Signed in: no more checks.
    await vi.advanceTimersByTimeAsync(POLL * 5)
    expect(check).toHaveBeenCalledTimes(4)
  })

  it('never runs two checks at once', async () => {
    let release: (v: boolean) => void = () => undefined
    const check = vi.fn(() => new Promise<boolean>((r) => (release = r)))
    const { flow } = flowWith('claude', check)
    await flow.start()
    await vi.advanceTimersByTimeAsync(POLL * 3)
    expect(check).toHaveBeenCalledTimes(1)
    release(false)
    await vi.advanceTimersByTimeAsync(POLL)
    expect(check).toHaveBeenCalledTimes(2)
  })

  it('checks once more when the command exits: signed in, or ended', async () => {
    const a = flowWith('claude', async () => true)
    await a.flow.start()
    a.p.exit(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(a.flow.view().phase).toBe('signedIn')

    // Exit code 0 without a sign-in is not a success.
    const check = vi.fn(async () => false)
    const b = flowWith('claude', check)
    await b.flow.start()
    b.p.exit(0)
    await vi.advanceTimersByTimeAsync(POLL * 3)
    expect(b.flow.view().phase).toBe('ended')
    expect(check).toHaveBeenCalledTimes(1)
  })

  it('cancel stops the process and the checks', async () => {
    const check = vi.fn(async () => true)
    const { flow, p, events } = flowWith('claude', check)
    await flow.start()
    await flow.cancel()
    expect(p.proc.kill).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(POLL * 3)
    expect(check).not.toHaveBeenCalled()
    expect(flow.view().phase).toBe('cancelled')
    expect(events.filter((e) => e.type === 'view').at(-1)).toMatchObject({ view: { phase: 'cancelled' } })
  })

  it('a resize after the terminal ended is ignored', async () => {
    // node-pty throws "Cannot resize a pty that has already exited" between a cancel and the exit event.
    const { flow, p } = flowWith('claude', async () => false)
    await flow.start()
    p.proc.resize = () => {
      throw new Error('Cannot resize a pty that has already exited')
    }
    expect(() => flow.resize(80, 24)).not.toThrow()
  })

  it('answers the question GitHub asks before its browser step, once', async () => {
    const { flow, p } = flowWith('github', async () => false)
    await flow.start()
    p.print('\x1b[32m?\x1b[0m Authenticate Git with your Git')
    expect(p.typed).toEqual([])
    p.print('Hub credentials? (Y/n) ')
    expect(p.typed).toEqual(['\r'])
    // The question stays in the output read so far: more output does not answer it again.
    p.print('\r\n! First copy your one-time code: AB12-CD34\r\n')
    expect(p.typed).toEqual(['\r'])
    expect(flow.view().prompt.code).toBe('AB12-CD34')
  })

  it('keeps the filled-in answer of the question GitLab asks first', async () => {
    const p = fakeProcess()
    const flow = new SignInFlow({ tool: 'gitlab', accountName: '', spawn: p.spawn, check: async () => false, emit: () => undefined, openUrl: () => undefined, pollMs: POLL })
    await flow.start()
    p.print('- Signing into gitlab.com\r\n┃ What domains does this host use for the container registry and image dependency proxy? \r\n┃ > gitlab.com,gitlab.com:443,registry.gitlab.com')
    // The form redraws itself: the same question printed again is not answered twice.
    p.print('\x1b[2K┃ What domains does this host use for the container registry and image dependency proxy? ')
    expect(p.typed).toEqual(['\r'])
  })

  it('opens the address GitLab prints once it is whole, a single time', async () => {
    const p = fakeProcess()
    const opened: string[] = []
    const flow = new SignInFlow({ tool: 'gitlab', accountName: '', spawn: p.spawn, check: async () => false, emit: () => undefined, openUrl: (u) => opened.push(u), pollMs: POLL })
    await flow.start()
    // Output comes in pieces: half an address is not opened.
    p.print('Failed opening a browser at https://gitlab.com/oauth/authorize?client_id=abc&redirect_uri=http%3A%2F%2Flocalhost%3A7171')
    expect(opened).toEqual([])
    p.print('%2Fauth%2Fredirect&state=xyz\r\nEncountered error: exec: "workhub-opens-the-browser": executable file not found\r\n')
    expect(opened).toEqual(['https://gitlab.com/oauth/authorize?client_id=abc&redirect_uri=http%3A%2F%2Flocalhost%3A7171%2Fauth%2Fredirect&state=xyz'])
    p.print('Try entering the URL in your browser manually.\r\n')
    expect(opened).toHaveLength(1)
    expect(flow.view().prompt.url).toBe(opened[0])
  })

  it('GitLab: the pane does not show what the tool says about its own browser launch, nor what it prints after a cancel', async () => {
    const p = fakeProcess()
    const events: SignInEvent[] = []
    const flow = new SignInFlow({ tool: 'gitlab', accountName: '', spawn: p.spawn, check: async () => false, emit: (e) => events.push(e), openUrl: () => undefined, pollMs: POLL })
    await flow.start()
    p.print('- Signing into gitlab.com\r\nFailed opening a browser at https://gitlab.com/oauth/authorize?state=xyz\r\nEncountered error: exec: "workhub-opens-the-browser": executable file not found in %PATH%\r\nTry entering the URL in your browser manually.\r\n')
    const shown = () => events.flatMap((e) => (e.type === 'output' ? [e.data] : [])).join('')
    expect(shown()).toBe('- Signing into gitlab.com\r\n')
    // The address is still read from what the tool printed.
    expect(flow.view().prompt.url).toBe('https://gitlab.com/oauth/authorize?state=xyz')
    await flow.cancel()
    p.print('   ERROR  \r\n  the command execution has been interrupted.\r\n')
    expect(shown()).toBe('- Signing into gitlab.com\r\n')
  })

  it('does not open the address of a tool that opens its browser itself', async () => {
    const { flow, p, opened } = flowWith('claude', async () => false)
    await flow.start()
    p.print('Open this address to sign in: https://claude.example.com/login?code=1\r\n')
    expect(opened).toEqual([])
  })

  it('a command that cannot start fails without polling', async () => {
    const check = vi.fn(async () => true)
    const flow = new SignInFlow({ tool: 'claude', accountName: '', spawn: () => Promise.reject(new Error('not found')), check, emit: () => undefined, openUrl: () => undefined, pollMs: POLL })
    expect(await flow.start()).toMatchObject({ phase: 'failed', error: 'not found' })
    await vi.advanceTimersByTimeAsync(POLL * 3)
    expect(check).not.toHaveBeenCalled()
  })

  it('reads the code from the output, opens the page and presses Enter for the GitHub CLI', async () => {
    const { flow, p, events, opened } = flowWith('github', async () => false)
    await flow.start()
    flow.openBrowser()
    expect(opened).toEqual([])
    p.print('! First copy your one-time code: ')
    p.print('AB12-CD34\r\nPress Enter to open github.com in your browser... ')
    expect(flow.view().prompt).toEqual({ code: 'AB12-CD34', url: null })
    expect(events.some((e) => e.type === 'output')).toBe(true)
    flow.openBrowser()
    expect(opened).toEqual(['https://github.com/login/device'])
    expect(p.typed).toEqual(['\r'])
    // A second click opens the page again but types nothing (it could answer gh's next question).
    flow.openBrowser()
    expect(opened).toHaveLength(2)
    expect(p.typed).toEqual(['\r'])
  })
})

describe('SignInService', () => {
  const config = {
    accounts: [
      { id: 'work', agentId: 'claude', name: 'Work', configDir: '/tmp/acme-claude-work' },
      { id: 'main', agentId: 'claude', name: 'Main', configDir: '/tmp/acme-home/.claude' },
      { id: 'cx', agentId: 'codex', name: 'Codex work' }
    ],
    agents: []
  } as unknown as WorkhubConfig

  function service(run = vi.fn(async (): Promise<Probe> => ({ result: 'failed', output: '{"loggedIn":false}' })), signedIn?: () => void) {
    const started: StartSessionRequest[] = []
    let listener: (e: AgentEvent) => void = () => undefined
    const terminal: SignInTerminal = {
      start: vi.fn(async (req: StartSessionRequest) => {
        started.push(req)
        return { agentName: req.agent.name, permissionMode: { id: 'unknown', label: '', source: 'unknown' as const } }
      }),
      subscribe: (l) => {
        listener = l
        return () => undefined
      },
      stop: vi.fn(async (id: string) => listener({ sessionId: id, type: 'exit', code: 0 })),
      write: vi.fn(),
      resize: vi.fn()
    }
    const windows: string[] = []
    const closers = new Map<string, () => void>()
    const s = new SignInService({
      config: async () => config,
      home: '/tmp/acme-home',
      path: () => '/usr/bin',
      terminal,
      openWindow: (id, closed) => {
        windows.push(id)
        closers.set(id, closed)
      },
      openUrl: () => undefined,
      ...(signedIn ? { signedIn } : {}),
      run
    })
    return { s, started, windows, closers, terminal, run, emit: (e: AgentEvent) => listener(e) }
  }

  it('refuses anything outside the fixed list, and an account for another tool or an unknown one', async () => {
    const { s, windows } = service()
    for (const tool of ['bash', 'claude auth login', '', null, 7, '__proto__', 'shell']) expect(await s.open(tool, null)).toBe(false)
    expect(await s.open('github', 'work')).toBe(false)
    expect(await s.open('claude', 'cx')).toBe(false)
    expect(await s.open('claude', 'nobody')).toBe(false)
    expect(await s.open('claude', 42)).toBe(false)
    expect(windows).toEqual([])
  })

  it('runs the table\'s command in a terminal of its own, with the account\'s config folder', async () => {
    const { s, started, windows, run } = service()
    expect(await s.open('claude', 'work')).toBe(true)
    expect(windows).toHaveLength(1)
    // Nothing runs until the window attaches.
    expect(started).toHaveLength(0)
    const sender = { send: vi.fn(), isDestroyed: () => false }
    expect(await s.attach(windows[0], sender)).toMatchObject({ tool: 'claude', accountName: 'Work', phase: 'running' })
    expect(started[0]).toMatchObject({ agent: { command: 'claude', args: ['auth', 'login'] }, cwd: '/tmp/acme-home' })
    expect(started[0]!.env['CLAUDE_CONFIG_DIR']).toMatch(/acme-claude-work$/)
    // A second attach (a reload) does not start another command.
    await s.attach(windows[0], sender)
    expect(started).toHaveLength(1)
    expect(run).not.toHaveBeenCalled()
  })

  it('a second open of a running sign-in brings its window up; closing the window stops it', async () => {
    const { s, windows, closers, terminal } = service()
    await s.open('github', null)
    await s.attach(windows[0], { send: vi.fn(), isDestroyed: () => false })
    await s.open('github', undefined)
    expect(windows).toEqual([windows[0], windows[0]])
    closers.get(windows[0]!)!()
    await Promise.resolve()
    expect(terminal.stop).toHaveBeenCalledWith(windows[0])
    expect(s.flow(windows[0])).toBeUndefined()
    expect(await s.attach(windows[0], null)).toBeNull()
  })

  it('sends output and the found code to the window that attached', async () => {
    const { s, windows, emit } = service()
    await s.open('github', null)
    const sender = { send: vi.fn(), isDestroyed: () => false }
    await s.attach(windows[0], sender)
    emit({ sessionId: windows[0]!, type: 'output', data: '! First copy your one-time code: AB12-CD34\n' })
    expect(sender.send).toHaveBeenCalledWith('signIn:event', windows[0], { type: 'output', data: '! First copy your one-time code: AB12-CD34\n' })
    expect(sender.send).toHaveBeenCalledWith('signIn:event', windows[0], { type: 'view', view: expect.objectContaining({ prompt: { code: 'AB12-CD34', url: null } }) })
  })

  it('tells the app when a sign-in ends signed in, and not when it ends otherwise', async () => {
    // The setup check that opened the window reads its rows again on this.
    const signedIn = vi.fn()
    const ok = service(vi.fn(async (): Promise<Probe> => ({ result: 'ok', output: 'octo' })), signedIn)
    await ok.s.open('github', null)
    await ok.s.attach(ok.windows[0], { send: vi.fn(), isDestroyed: () => false })
    ok.emit({ sessionId: ok.windows[0]!, type: 'exit', code: 0 })
    await vi.waitFor(() => expect(ok.s.flow(ok.windows[0])!.view().phase).toBe('signedIn'))
    expect(signedIn).toHaveBeenCalledTimes(1)

    const not = service(undefined, signedIn)
    await not.s.open('github', null)
    await not.s.attach(not.windows[0], { send: vi.fn(), isDestroyed: () => false })
    not.emit({ sessionId: not.windows[0]!, type: 'exit', code: 1 })
    await vi.waitFor(() => expect(not.s.flow(not.windows[0])!.view().phase).toBe('ended'))
    expect(signedIn).toHaveBeenCalledTimes(1)
  })

  it('names no folder for the default account, so it signs in where sessions read', async () => {
    const run = vi.fn(async (): Promise<Probe> => ({ result: 'failed', output: '{"loggedIn":false}' }))
    const { s, started, windows } = service(run)
    expect(await s.open('claude', null)).toBe(true)
    await s.attach(windows[0], { send: vi.fn(), isDestroyed: () => false })
    expect(started[0]!.env).not.toHaveProperty('CLAUDE_CONFIG_DIR')
  })

  it('names the folder of an account configured with the default folder, as a session does', async () => {
    const run = vi.fn(async (): Promise<Probe> => ({ result: 'failed', output: '{"loggedIn":false}' }))
    const { s, started, windows } = service(run)
    expect(await s.open('claude', 'main')).toBe(true)
    await s.attach(windows[0], { send: vi.fn(), isDestroyed: () => false })
    expect(started[0]!.env['CLAUDE_CONFIG_DIR']).toMatch(/acme-home[\\/]\.claude$/)
  })

  it('the status check runs the table\'s check with the account\'s folder on the app\'s PATH', async () => {
    const run = vi.fn(async (): Promise<Probe> => ({ result: 'ok', output: '{"loggedIn":true}' }))
    const { s, windows, emit } = service(run)
    await s.open('claude', 'work')
    await s.attach(windows[0], { send: vi.fn(), isDestroyed: () => false })
    emit({ sessionId: windows[0]!, type: 'exit', code: 0 })
    await vi.waitFor(() => expect(s.flow(windows[0])!.view().phase).toBe('signedIn'))
    const [command, args, options] = run.mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }]
    expect([command, args]).toEqual(['claude', ['auth', 'status']])
    expect(options.env['PATH']).toBe('/usr/bin')
    expect(options.env['CLAUDE_CONFIG_DIR']).toMatch(/acme-claude-work$/)
  })
})

describe('sign-in reach', () => {
  it('is not offered to paired devices', () => {
    for (const table of [REMOTE_INVOKES, REMOTE_MESSAGES, REMOTE_EVENTS]) expect(Object.keys(table).filter((c) => c.startsWith('signIn:'))).toEqual([])
  })

  it('window hash round trip', () => {
    expect(parseSignInHash(signInHash('a b'))).toBe('a b')
    expect(parseSignInHash('#setup')).toBeNull()
    expect(parseSignInHash('#signin?id=')).toBeNull()
  })
})
