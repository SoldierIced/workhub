import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import {
  isSignInTool,
  hideOutputLines,
  parseSignInPrompt,
  plainTerminalText,
  SIGN_IN_COMMANDS,
  signInReady,
  NO_CAPABILITIES,
  type AgentRuntime,
  type SignInPrompt,
  type SignInTool,
  type TerminalControl,
  type WorkhubConfig
} from '@workhub/core'
import type { SignInEvent, SignInPhase, SignInView } from '../shared/sign-in-api'
import { claudeLaunchDir } from './claude-accounts'
import type { IpcRegistrar } from './ipc-guard'
import { probe } from './setup-service'

/** How often the status check runs while the sign-in command is still open. */
export const SIGN_IN_POLL_MS = 4000
/** Only the tail of the output is searched for the address and the code. */
const OUTPUT_TAIL = 16_000

/** The running sign-in command, as a flow sees it. */
export interface SignInProcess {
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): Promise<void>
}

export interface SignInFlowDeps {
  tool: SignInTool
  accountName: string
  /** Starts the command; rejects when it cannot start (not installed). */
  spawn: (on: { output: (data: string) => void; exit: (code: number) => void }) => Promise<SignInProcess>
  /** The tool's status check: true once signed in. */
  check: () => Promise<boolean>
  emit: (event: SignInEvent) => void
  /** Opens a web address through the link service. */
  openUrl: (url: string) => void
  pollMs?: number
}

/**
 * One sign-in: runs the command, reads the address and code it prints, and checks the status
 * every few seconds while it runs and once when it ends. Signed in stops the checks but leaves the
 * command running (a tool may still ask one last question in the terminal); Cancel stops it.
 */
export class SignInFlow {
  private phase: SignInPhase = 'running'
  private prompt: SignInPrompt = { url: null, code: null }
  private error: string | undefined
  private tail = ''
  private proc: SignInProcess | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private checking = false
  private started = false
  private exited = false
  /** The keys after "Open browser" go once: a second Enter could answer the tool's next question. */
  private typedAfterOpen = false
  /** The questions already answered (`answers` of the command): each one once. */
  private readonly answered = new Set<string>()
  /** The printed address was opened for the person (`openWhenPrinted`): once. */
  private openedPrinted = false
  /** What the pane shows of the output (`hiddenLines` of the command); null shows all of it. */
  private readonly shown: ((data: string) => string) | null

  constructor(private readonly deps: SignInFlowDeps) {
    const hidden = SIGN_IN_COMMANDS[deps.tool].hiddenLines
    this.shown = hidden?.length ? hideOutputLines(hidden) : null
  }

  view(): SignInView {
    return { tool: this.deps.tool, accountName: this.deps.accountName, phase: this.phase, prompt: this.prompt, ...(this.error ? { error: this.error } : {}) }
  }

  /** Starts the command once; later calls only return the view. */
  async start(): Promise<SignInView> {
    if (this.started) return this.view()
    this.started = true
    try {
      this.proc = await this.deps.spawn({ output: (data) => this.onOutput(data), exit: () => void this.onExit() })
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err)
      this.setPhase('failed')
      return this.view()
    }
    // A cancel or an exit that came while it was starting.
    if (this.phase !== 'running' || this.exited) return this.view()
    this.timer = setInterval(() => void this.poll(), this.deps.pollMs ?? SIGN_IN_POLL_MS)
    return this.view()
  }

  write(data: string): void {
    if (!this.exited) this.proc?.write(data)
  }

  resize(cols: number, rows: number): void {
    if (this.exited || !(cols > 0 && rows > 0)) return
    try {
      this.proc?.resize(cols, rows)
    } catch {
      // A cancel ends the terminal before its exit is reported: a resize in between has nothing to resize.
    }
  }

  /** Opens the printed address (or the tool's device page once a code is printed), then types what the tool waits for. */
  openBrowser(): void {
    const url = this.prompt.url ?? (this.prompt.code ? (SIGN_IN_COMMANDS[this.deps.tool].deviceUrl ?? null) : null)
    if (!url) return
    this.deps.openUrl(url)
    const keys = SIGN_IN_COMMANDS[this.deps.tool].afterOpen
    if (keys && this.phase === 'running' && !this.typedAfterOpen) {
      this.typedAfterOpen = true
      this.write(keys)
    }
  }

  /** Stops the command; a finished sign-in keeps its answer. */
  async cancel(): Promise<void> {
    this.stopPolling()
    if (this.phase === 'running') this.setPhase('cancelled')
    if (!this.exited) await this.proc?.kill()
  }

  private onOutput(data: string): void {
    // After a cancel the tool only prints that it was interrupted, as an error: the pane already says "cancelled".
    if (this.phase === 'cancelled') return
    const shown = this.shown ? this.shown(data) : data
    if (shown) this.deps.emit({ type: 'output', data: shown })
    this.tail = (this.tail + data).slice(-OUTPUT_TAIL)
    this.answerQuestions()
    const next = parseSignInPrompt(this.tail)
    if (next.url !== this.prompt.url || next.code !== this.prompt.code) {
      // An address or code once read stays until the tool prints a new one.
      this.prompt = { url: next.url ?? this.prompt.url, code: next.code ?? this.prompt.code }
      this.deps.emit({ type: 'view', view: this.view() })
    }
    this.openPrintedAddress()
  }

  /**
   * Opens the address for a tool whose own browser launch is off, once it is printed whole: output
   * comes in pieces, so the address counts as whole only when something follows it.
   */
  private openPrintedAddress(): void {
    const url = this.prompt.url
    if (this.openedPrinted || !url || this.phase !== 'running' || !SIGN_IN_COMMANDS[this.deps.tool].openWhenPrinted) return
    const text = plainTerminalText(this.tail)
    const end = text.lastIndexOf(url) + url.length
    if (end < url.length || !/\s/.test(text.slice(end))) return
    this.openedPrinted = true
    this.deps.openUrl(url)
  }

  /** Types the answer to a question the tool asks before its browser step, once each. */
  private answerQuestions(): void {
    const answers = SIGN_IN_COMMANDS[this.deps.tool].answers
    if (!answers || this.phase !== 'running') return
    const text = plainTerminalText(this.tail)
    for (const { question, keys } of answers) {
      if (this.answered.has(question) || !text.includes(question)) continue
      this.answered.add(question)
      this.write(keys)
    }
  }

  private async onExit(): Promise<void> {
    this.exited = true
    this.stopPolling()
    if (this.phase !== 'running') return
    // The last word is the status check's: the command may exit 0 without signing in, or non-zero after it did.
    const ready = await this.deps.check().catch(() => false)
    if (this.phase === 'running') this.setPhase(ready ? 'signedIn' : 'ended')
  }

  private async poll(): Promise<void> {
    if (this.checking || this.phase !== 'running') return
    this.checking = true
    try {
      const ready = await this.deps.check().catch(() => false)
      if (ready && this.phase === 'running') {
        this.stopPolling()
        this.setPhase('signedIn')
      }
    } finally {
      this.checking = false
    }
  }

  private stopPolling(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private setPhase(phase: SignInPhase): void {
    this.phase = phase
    this.deps.emit({ type: 'view', view: this.view() })
  }
}

/** The PTY runtime as the sign-in service uses it: a TerminalRuntime of its own, so a sign-in is never a session. */
export type SignInTerminal = Pick<AgentRuntime, 'start' | 'subscribe' | 'stop'> & Pick<TerminalControl, 'write' | 'resize'>

export interface SignInServiceDeps {
  config: () => Promise<WorkhubConfig>
  home: string
  /** The PATH the status checks run with (the app's, plus the bundled Claude Code); the terminal adds the same itself. */
  path: () => string
  terminal: SignInTerminal
  /** Opens (or focuses) the sign-in window of a flow; `closed` runs when that window closes. */
  openWindow: (id: string, closed: () => void) => void
  openUrl: (url: string) => void
  /** A sign-in finished signed in: what the setup check found is out of date. */
  signedIn?: () => void
  /** Test seam: replaces the command runner of the status checks. */
  run?: typeof probe
  pollMs?: number
}

interface Entry {
  key: string
  flow: SignInFlow
  sender: Pick<WebContents, 'send' | 'isDestroyed'> | null
}

/**
 * Sign-ins inside Workhub (`signIn:*`). The caller names a tool of the fixed list and, for Claude,
 * an account; the command line is always the main process's own. Not offered to paired devices
 * (not in the remote allowlist) nor through the control endpoint.
 */
export class SignInService {
  private readonly flows = new Map<string, Entry>()
  /** The output and exit of each started command, by flow id. */
  private readonly handlers = new Map<string, { output: (data: string) => void; exit: (code: number) => void }>()

  constructor(private readonly deps: SignInServiceDeps) {
    deps.terminal.subscribe((event) => {
      const on = this.handlers.get(event.sessionId)
      if (event.type === 'output') on?.output(event.data)
      else if (event.type === 'exit') on?.exit(event.code ?? 0)
    })
  }

  /** Opens a sign-in window; false for a tool outside the list, an account given for another tool, or an unknown account. */
  async open(tool: unknown, accountId: unknown): Promise<boolean> {
    if (!isSignInTool(tool)) return false
    if (accountId !== null && accountId !== undefined && (typeof accountId !== 'string' || tool !== 'claude')) return false
    const config = await this.deps.config()
    const account = typeof accountId === 'string' ? (config.accounts.find((a) => a.id === accountId && a.agentId === 'claude') ?? null) : null
    if (typeof accountId === 'string' && !account) return false
    const key = `${tool}:${account?.id ?? ''}`
    // A second click while one runs brings its window up instead of starting another.
    for (const [id, entry] of this.flows) {
      if (entry.key === key && entry.flow.view().phase === 'running') {
        this.deps.openWindow(id, () => this.close(id))
        return true
      }
    }
    const env: Record<string, string> = { ...SIGN_IN_COMMANDS[tool].env }
    if (tool === 'claude') {
      const launch = claudeLaunchDir(config, account)
      if (launch.kind === 'named') env['CLAUDE_CONFIG_DIR'] = launch.dir
    }
    const id = randomUUID()
    const entry: Entry = { key, sender: null, flow: null as unknown as SignInFlow }
    entry.flow = new SignInFlow({
      tool,
      accountName: account?.name ?? '',
      pollMs: this.deps.pollMs,
      spawn: (on) => this.spawn(id, tool, env, on),
      check: () => this.check(tool, env),
      emit: (event) => {
        if (entry.sender && !entry.sender.isDestroyed()) entry.sender.send('signIn:event', id, event)
        // The row that opened this window (setup check, welcome, Home) reads the check again.
        if (event.type === 'view' && event.view.phase === 'signedIn') this.deps.signedIn?.()
      },
      openUrl: this.deps.openUrl
    })
    this.flows.set(id, entry)
    this.deps.openWindow(id, () => this.close(id))
    return true
  }

  /** The window of a flow asks for it: the command starts with the first attach. */
  async attach(id: unknown, sender: Entry['sender']): Promise<SignInView | null> {
    const entry = typeof id === 'string' ? this.flows.get(id) : undefined
    if (!entry) return null
    entry.sender = sender
    return entry.flow.start()
  }

  flow(id: unknown): SignInFlow | undefined {
    return typeof id === 'string' ? this.flows.get(id)?.flow : undefined
  }

  /** The window closed: the command stops and the flow is forgotten. */
  close(id: string): void {
    const entry = this.flows.get(id)
    if (!entry) return
    this.flows.delete(id)
    void entry.flow.cancel().finally(() => this.handlers.delete(id))
  }

  private async spawn(id: string, tool: SignInTool, env: Record<string, string>, on: { output: (data: string) => void; exit: (code: number) => void }): Promise<SignInProcess> {
    const { command, args } = SIGN_IN_COMMANDS[tool]
    this.handlers.set(id, on)
    try {
      await this.deps.terminal.start({
        sessionId: id,
        agent: { id: `sign-in-${tool}`, name: command, adapter: 'terminal', command, args, capabilities: { ...NO_CAPABILITIES }, modeSemantics: 'none' },
        account: null,
        cwd: this.deps.home,
        env
      })
    } catch (err) {
      this.handlers.delete(id)
      throw err
    }
    return {
      write: (data) => this.deps.terminal.write(id, data),
      resize: (cols, rows) => this.deps.terminal.resize(id, cols, rows),
      kill: () => this.deps.terminal.stop(id)
    }
  }

  private async check(tool: SignInTool, env: Record<string, string>): Promise<boolean> {
    const { command, args } = SIGN_IN_COMMANDS[tool].status
    const p = await (this.deps.run ?? probe)(command, args, { env: { ...process.env, PATH: this.deps.path(), ...env } })
    return signInReady(tool, p)
  }
}

/** `signIn:open` (the entry point, `hub.signIn`) and the sign-in window's own calls. */
export function registerSignInIpc(ipc: IpcRegistrar, service: SignInService): void {
  ipc.handle('signIn:open', (_e, tool: unknown, accountId: unknown) => service.open(tool, accountId))
  ipc.handle('signIn:attach', (e, id: unknown) => service.attach(id, e.sender))
  ipc.on('signIn:write', (_e, id: unknown, data: unknown) => {
    if (typeof data === 'string') service.flow(id)?.write(data)
  })
  ipc.on('signIn:resize', (_e, id: unknown, cols: unknown, rows: unknown) => {
    if (Number.isInteger(cols) && Number.isInteger(rows)) service.flow(id)?.resize(cols as number, rows as number)
  })
  ipc.on('signIn:openBrowser', (_e, id: unknown) => service.flow(id)?.openBrowser())
  ipc.on('signIn:cancel', (_e, id: unknown) => void service.flow(id)?.cancel())
}
