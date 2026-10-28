import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NO_CAPABILITIES, type SessionState } from '@workhub/core'
import type { SessionView, StartSessionInput } from '../src/shared/api'
import { expandHome } from '../src/main/automations'
import { SessionDriver, type DrivableSessions } from '../src/main/session-driver'
import { SendGate } from '../src/main/send-gate'

function view(id: string, state: SessionState, over: Partial<SessionView> = {}): SessionView {
  return {
    id,
    identity: `provisional-${id}`,
    agentId: 'demo',
    accountId: null,
    profileId: null,
    cwd: '/tmp/demo',
    state,
    permissionMode: null,
    startedAt: 1,
    label: 'Demo',
    agentName: 'Demo',
    adapter: 'acp',
    capabilities: NO_CAPABILITIES,
    screens: [],
    modes: ['app'],
    mode: 'app',
    shellRunning: false,
    controls: false,
    ...over
  }
}

function setup() {
  const views: SessionView[] = []
  const prompts: [string, string][] = []
  const writes: [string, string][] = []
  const shown: [string, string][] = []
  // The session manager's gate, with turns that end when the test says so.
  const gate = new SendGate()
  const turns: (() => void)[] = []
  const turn = (id: string, text: string) => () => {
    prompts.push([id, text])
    return new Promise<string>((resolve) => turns.push(() => resolve('end_turn')))
  }
  const sessions: DrivableSessions = {
    list: () => views,
    start: async (_i: StartSessionInput) => views[0]!,
    prompt: (id, text) => gate.run(id, turn(id, text)),
    tryPrompt: (id, text) => gate.tryRun(id, turn(id, text)),
    write: (channel, data) => void writes.push([channel, data]),
    cancel: async () => undefined,
    stop: async () => undefined,
    remove: (id) => {
      const i = views.findIndex((v) => v.id === id)
      if (i < 0 || views[i]!.state === 'ready' || views[i]!.state === 'busy') return false
      views.splice(i, 1)
      return true
    }
  }
  const driver = new SessionDriver(sessions, (id, text) => void shown.push([id, text]))
  const endTurn = async () => {
    turns.shift()?.()
    await new Promise((r) => setTimeout(r, 0))
  }
  return { views, prompts, writes, shown, driver, sessions, endTurn }
}

describe('session driver', () => {
  it('counts finished turns and reports a session that gets its real identity late', () => {
    const { views, driver } = setup()
    const renamed: [string, string][] = []
    driver.onIdentityChanged = (a, b) => void renamed.push([a, b])
    views.push(view('v1', 'starting'))
    driver.onChanged(views[0]!)
    views[0] = { ...views[0]!, state: 'busy', identity: 'real-1', agentSessionId: 'real-1' }
    driver.onChanged(views[0])
    views[0] = { ...views[0], state: 'ready' }
    driver.onChanged(views[0])
    expect(renamed).toEqual([['provisional-v1', 'real-1']])
    expect(driver.list()[0]).toMatchObject({ identity: 'real-1', turnsEnded: 1 })
  })

  it('forgets a stopped session it drops, and keeps a live one', async () => {
    const { views, driver } = setup()
    views.push(view('v1', 'ready'), view('v2', 'stopped'))
    views.forEach((v) => driver.onChanged(v))
    await driver.forget('v1')
    expect(driver.list().map((s) => s.id)).toEqual(['v1', 'v2'])
    await driver.forget('v2')
    expect(driver.list().map((s) => s.id)).toEqual(['v1'])
  })

  it('types into the chat or the console, and waits while the session is busy', async () => {
    const { views, driver, prompts, writes, shown } = setup()
    views.push(view('v1', 'busy'), view('v2', 'ready', { mode: 'console', modes: ['console', 'shell'] }), view('v3', 'ready'))
    expect(await driver.deliver('v1', 'hi')).toBe('waiting')
    expect(await driver.deliver('v3', 'hi')).toBe('delivered')
    expect(prompts).toEqual([['v3', 'hi']])
    expect(shown).toEqual([['v3', 'hi']])
    expect(await driver.deliver('v2', 'a\nb')).toBe('delivered')
    expect(writes).toEqual([['v2:console', 'a\rb\r']])
  })

  it('waits while another prompt of the session is in flight, even when the session still reads ready', async () => {
    const { views, driver, sessions, prompts, shown, endTurn } = setup()
    views.push(view('v1', 'ready'))
    // The user's queued message goes out as the session turns idle; the AI review delivers at the same moment.
    const user = sessions.prompt('v1', 'queued message')
    expect(await driver.deliver('v1', 'review findings')).toBe('waiting')
    expect(prompts).toEqual([['v1', 'queued message']])
    expect(shown).toEqual([])
    await endTurn()
    await user
    // The caller's retry finds the session free.
    expect(await driver.deliver('v1', 'review findings')).toBe('delivered')
    expect(prompts).toEqual([['v1', 'queued message'], ['v1', 'review findings']])
    // And a user prompt sent while the review's turn runs waits for it instead of running beside it.
    const late = sessions.prompt('v1', 'late message')
    expect(prompts).toHaveLength(2)
    await endTurn()
    expect(prompts.at(-1)).toEqual(['v1', 'late message'])
    await endTurn()
    await late
  })

  it('reports the end of a turn it typed, so the chat shows it like a user turn', async () => {
    const { views, driver, endTurn } = setup()
    const ended: [string, string][] = []
    driver.onTurnEnded = (id, reason) => void ended.push([id, reason])
    views.push(view('v1', 'ready'))
    expect(await driver.deliver('v1', 'wake')).toBe('delivered')
    expect(ended).toEqual([])
    await endTurn()
    expect(ended).toEqual([['v1', 'end_turn']])
  })

  it('keeps the usage the session monitor reports and forgets it with the session', async () => {
    const { views, driver } = setup()
    views.push(view('v1', 'ready'), view('v2', 'stopped'))
    views.forEach((v) => driver.onChanged(v))
    driver.onEvent({ sessionId: 'v1', type: 'monitor', snapshot: { cost: { amount: 0.5, currency: 'USD' }, tokens: { total: 900 } } })
    expect(driver.list()[0]?.usage).toEqual({ cost: { amount: 0.5, currency: 'USD' }, tokens: 900 })
    expect(driver.list()[1]).not.toHaveProperty('usage')
    driver.onEvent({ sessionId: 'v1', type: 'monitor', snapshot: { title: 'nothing to count' } })
    expect(driver.list()[0]).not.toHaveProperty('usage')
  })

  it('expands ~ in automation folders', () => {
    expect(expandHome('~', '/home/me')).toBe('/home/me')
    expect(expandHome('~/work', '/home/me')).toBe(join('/home/me', 'work'))
    expect(expandHome('/abs', '/home/me')).toBe('/abs')
  })
})
