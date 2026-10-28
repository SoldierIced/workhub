import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { emptyConfig, NO_CAPABILITIES, NO_MODULES, type AgentAccount, type BudgetStatus, type HandoffFacts, type Profile, type SessionOrigin, type WorkhubConfig } from '@workhub/core'
import { claudeConfigDirOf } from '../src/main/claude-accounts'
import { CONTINUE_AFTER_LIMIT_PROMPT, ContinuityService, type ContinuityDeps, type ContinuitySessions } from '../src/main/continuity'
import type { SessionView, StartSessionInput } from '../src/shared/api'
import type { ContinuityMoved, ContinuityOffer } from '../src/shared/continuity-api'

const personal: AgentAccount = { id: 'personal', agentId: 'claude', name: 'Personal' }
const laboral: AgentAccount = { id: 'laboral', agentId: 'claude', name: 'Laboral', configDir: '/tmp/wh-laboral' }

function makeConfig(mode?: Profile['accountFailover']): WorkhubConfig {
  const profile: Profile = { id: 'p', name: 'P', connections: {}, accountIds: ['personal', 'laboral'], modules: { ...NO_MODULES }, preferredAgents: ['codex'], ...(mode ? { accountFailover: mode } : {}) }
  return { ...emptyConfig(), accounts: [personal, laboral], profiles: [profile], activeProfileId: 'p' }
}

function view(over: Partial<SessionView> = {}): SessionView {
  return {
    id: 'w1',
    identity: 'sess-1',
    agentId: 'claude',
    accountId: 'personal',
    accountName: 'Personal',
    profileId: 'p',
    cwd: '/work/pay',
    state: 'ready',
    agentSessionId: 'sess-1',
    permissionMode: null,
    startedAt: 1,
    label: 'Claude Code · Personal',
    agentName: 'Claude Code',
    adapter: 'native',
    capabilities: { ...NO_CAPABILITIES, appMode: true },
    screens: [],
    modes: ['app'],
    mode: 'app',
    shellRunning: false,
    controls: true,
    ...over
  }
}

/** Sessions that start ready at once (or `starting` until the test says otherwise). */
class FakeSessions implements ContinuitySessions {
  views: SessionView[] = []
  started: { input: StartSessionInput; origin?: SessionOrigin }[] = []
  stopped: string[] = []
  prompts: [string, string][] = []
  removed: string[] = []
  startState: SessionView['state'] = 'ready'
  onPrompt: (id: string, text: string) => Promise<string> = async () => 'end_turn'
  private n = 1
  list() {
    return this.views
  }
  async start(input: StartSessionInput, internal: { origin?: SessionOrigin } = {}) {
    this.started.push({ input, ...(internal.origin ? { origin: internal.origin } : {}) })
    const [agentId, accountId] = input.agentKey.split(':')
    const v = view({ id: `w${++this.n}`, agentId: agentId!, accountId: accountId ?? null, identity: input.resumeAgentSessionId ?? `new-${this.n}`, agentSessionId: input.resumeAgentSessionId, state: this.startState, label: input.agentKey, adapter: agentId === 'claude' ? 'native' : 'acp', ...(internal.origin ? { origin: internal.origin } : {}) })
    this.views.push(v)
    return v
  }
  async stop(id: string) {
    this.stopped.push(id)
    this.views = this.views.map((v) => (v.id === id ? { ...v, state: 'stopped' } : v))
  }
  async prompt(id: string, text: string) {
    this.prompts.push([id, text])
    return this.onPrompt(id, text)
  }
  remove(id: string) {
    this.removed.push(id)
    this.views = this.views.filter((v) => v.id !== id)
    return true
  }
}

const facts: HandoffFacts = { goal: 'Add a retry', pullRequests: [], tickets: ['ABC-1'], filesTouched: ['src/a.ts'], commands: ['npm test'], todos: [], exchanges: [{ role: 'user', text: 'Add a retry' }] }

function setup(opts: { mode?: Profile['accountFailover']; budget?: (agentId: string, accountId: string | null) => BudgetStatus; copy?: ContinuityDeps['copySession'] } = {}) {
  const config = makeConfig(opts.mode)
  const sessions = new FakeSessions()
  sessions.views.push(view())
  const offers: ContinuityOffer[] = []
  const moved: ContinuityMoved[] = []
  const shown: [string, string][] = []
  const ended: [string, string][] = []
  const copySession = vi.fn(opts.copy ?? (async () => ({})))
  const placeBeside = vi.fn(async () => undefined)
  const service = new ContinuityService({
    config: async () => config,
    sessions,
    budgetOf: opts.budget ?? (() => ({ action: 'allow' })),
    claudeConfigDir: (account, c) => claudeConfigDirOf(c, account, '/home/u', {}),
    copySession,
    facts: async () => facts,
    git: async () => ({ branch: 'feat/retry', dirtyFiles: [] }),
    placeBeside,
    emitOffer: (o) => offers.push(o),
    emitMoved: (m) => moved.push(m),
    showPrompt: (id, text) => shown.push([id, text]),
    showTurnEnd: (id, reason) => ended.push([id, reason]),
    settleMs: 10_000
  })
  return { config, sessions, service, offers, moved, shown, ended, copySession, placeBeside }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('ContinuityService: account failover', () => {
  it('lists the other Claude account and the agents to hand off to', async () => {
    const { service } = setup()
    const o = await service.options('w1')
    expect(o.mode).toBe('ask')
    expect(o.failover).toEqual([{ key: 'claude:laboral', label: 'Claude Code · Laboral', budget: { action: 'allow' } }])
    expect(o.handoff[0]?.key).toBe('codex')
    expect(o.handoff.some((t) => t.key.startsWith('claude'))).toBe(false)
    expect(o.canSummarize).toBe(true)
  })

  it('moves the session: plan, stop, copy, resume the same id in the other account, drop the old view', async () => {
    const { service, sessions, copySession, moved } = setup()
    const next = await service.failover('w1', { reason: 'manual' })
    const copy = { sessionId: 'sess-1', cwd: '/work/pay', sourceConfigDir: resolve('/home/u/.claude'), targetConfigDir: resolve('/tmp/wh-laboral') }
    expect(copySession.mock.calls).toEqual([[{ ...copy, dryRun: true }], [copy]])
    expect(sessions.stopped).toEqual(['w1'])
    expect(sessions.started[0]).toMatchObject({
      input: { agentKey: 'claude:laboral', resumeAgentSessionId: 'sess-1', cwd: '/work/pay', mode: 'app', profileId: 'p' },
      origin: { kind: 'failover', fromLabel: 'Claude Code · Personal', fromIdentity: 'sess-1', reason: 'manual' }
    })
    // Same identity: the sidebar group and position stay.
    expect(next.identity).toBe('sess-1')
    expect(sessions.removed).toEqual(['w1'])
    expect(moved).toEqual([{ fromId: 'w1', toId: next.id, origin: sessions.started[0]!.origin }])
  })

  it('a refused plan (a conflicting copy) leaves the session running in its account', async () => {
    const { service, sessions } = setup({ copy: async () => Promise.reject(new Error('the other account already has a different copy')) })
    await expect(service.failover('w1', { reason: 'manual' })).rejects.toThrow('different copy')
    expect(sessions.stopped).toEqual([])
    expect(sessions.started).toEqual([])
  })

  it('a copy failing after the stop resumes the session back in its own account', async () => {
    let calls = 0
    const { service, sessions, moved } = setup({ copy: async () => (++calls === 2 ? Promise.reject(new Error('disk full')) : {}) })
    await expect(service.failover('w1', { reason: 'manual' })).rejects.toThrow('disk full')
    expect(sessions.started[0]?.input).toMatchObject({ agentKey: 'claude:personal', resumeAgentSessionId: 'sess-1' })
    expect(moved[0]?.fromId).toBe('w1')
  })

  it('refuses a busy session and an account past its ceiling', async () => {
    const busy = setup()
    busy.sessions.views[0] = view({ state: 'busy' })
    await expect(busy.service.failover('w1', { reason: 'manual' })).rejects.toThrow(/working/)
    const blocked = setup({ budget: (_a, id) => (id === 'laboral' ? { action: 'block', window: '5h', percent: 99, ceiling: 90 } : { action: 'allow' }) })
    await expect(blocked.service.failover('w1', { reason: 'manual' })).rejects.toThrow(/under its ceiling/)
    expect((await blocked.service.options('w1')).failover).toEqual([])
  })

  it('sends the prompt the gate held once the moved session is ready', async () => {
    const { service, sessions, shown, ended } = setup()
    sessions.startState = 'starting'
    const next = await service.failover('w1', { reason: 'ceiling', window: 'weekly', prompt: 'Run the tests' })
    expect(sessions.prompts).toEqual([])
    service.onChanged({ ...next, state: 'ready' })
    await flush()
    expect(sessions.prompts).toEqual([[next.id, 'Run the tests']])
    expect(shown).toEqual([[next.id, 'Run the tests']])
    // Its turn ends in the chat like one the user sent.
    expect(ended.map(([id]) => id)).toEqual([next.id])
    expect(sessions.started[0]?.origin).toMatchObject({ reason: 'ceiling', window: 'weekly' })
  })

  it('asks (by default) when the agent reports a limit, once for the several signals of one refusal', async () => {
    const { service, offers, sessions } = setup()
    service.onEvent({ sessionId: 'w1', type: 'usageLimit', window: '5h' })
    service.onEvent({ sessionId: 'w1', type: 'usageLimit', resetsAt: 9_999_999_999_999, message: "You've hit your limit" })
    service.onChanged(view({ state: 'ready' }))
    await flush()
    service.onEvent({ sessionId: 'w1', type: 'usageLimit' })
    service.onChanged(view({ state: 'ready' }))
    await flush()
    expect(offers).toEqual([
      {
        sessionId: 'w1',
        reason: 'limit',
        accountLabel: 'Personal',
        window: '5h',
        resetsAt: 9_999_999_999_999,
        target: { key: 'claude:laboral', label: 'Claude Code · Laboral', budget: { action: 'allow' } },
        handoff: { key: 'codex', label: 'Codex' }
      }
    ])
    expect(sessions.started).toEqual([])
  })

  it('waits for the turn to end before acting on a limit', async () => {
    const { service, offers } = setup()
    service.onEvent({ sessionId: 'w1', type: 'usageLimit' })
    service.onChanged(view({ state: 'busy' }))
    await flush()
    expect(offers).toEqual([])
    service.onChanged(view({ state: 'ready' }))
    await flush()
    expect(offers).toHaveLength(1)
  })

  it('switches by itself in automatic mode and tells Claude to go on', async () => {
    const { service, sessions, offers, moved } = setup({ mode: 'automatic' })
    service.onEvent({ sessionId: 'w1', type: 'usageLimit', window: '5h' })
    service.onChanged(view({ state: 'ready' }))
    await vi.waitFor(() => expect(sessions.prompts).toHaveLength(1))
    expect(offers).toEqual([])
    expect(moved[0]?.origin).toMatchObject({ kind: 'failover', reason: 'limit', window: '5h' })
    expect(sessions.prompts[0]![1]).toBe(CONTINUE_AFTER_LIMIT_PROMPT)
  })

  it('never goes back to an account that just reported a limit, until it resets', async () => {
    const { service, sessions } = setup({ mode: 'automatic' })
    service.onEvent({ sessionId: 'w1', type: 'usageLimit', resetsAt: Date.now() + 3_600_000 })
    service.onChanged(view({ state: 'ready' }))
    await vi.waitFor(() => expect(sessions.started).toHaveLength(1))
    const moved = sessions.views.find((v) => v.accountId === 'laboral')!
    expect((await service.options(moved.id)).failover).toEqual([])
  })

  it('does nothing when the profile turned it off', async () => {
    const { service, offers, sessions } = setup({ mode: 'off' })
    service.onEvent({ sessionId: 'w1', type: 'usageLimit' })
    service.onChanged(view({ state: 'ready' }))
    await flush()
    expect(offers).toEqual([])
    expect(sessions.started).toEqual([])
  })

  it('offers only the hand-off for a session another adapter runs', async () => {
    const { service, sessions } = setup()
    sessions.views[0] = view({ agentId: 'codex', accountId: null, adapter: 'acp', label: 'Codex' })
    const o = await service.options('w1')
    expect(o.failover).toEqual([])
    expect(o.handoff.map((t) => t.key)).toContain('claude:personal')
  })
})

describe('ContinuityService: hand-off', () => {
  it('opens the target in the same folder with the deterministic brief, linked and placed next to the source', async () => {
    const { service, sessions, placeBeside } = setup()
    const r = await service.handoff('w1', { targetKey: 'codex' })
    expect(sessions.started[0]).toMatchObject({ input: { agentKey: 'codex', cwd: '/work/pay', mode: 'app' }, origin: { kind: 'handoff', fromLabel: 'Claude Code · Personal', fromIdentity: 'sess-1' } })
    expect(r.brief).toContain('# Hand-off from Claude Code · Personal')
    expect(r.brief).toContain('- Branch: `feat/retry`')
    expect(r.brief).toContain('- `src/a.ts`')
    expect(sessions.prompts).toEqual([])
    // The source keeps running.
    expect(sessions.stopped).toEqual([])
    expect(placeBeside).toHaveBeenCalledWith({ key: r.view.identity, title: 'Claude Code', agentKey: 'codex', cwd: '/work/pay' }, 'sess-1')
  })

  it('asks the source to summarize when requested, and uses its reply', async () => {
    const { service, sessions, shown } = setup()
    sessions.onPrompt = async (id) => {
      service.onEvent({ sessionId: id, type: 'message', role: 'agent', text: '## Goal\nRetry the ' })
      service.onEvent({ sessionId: id, type: 'message', role: 'agent', text: 'payments client.' })
      return 'end_turn'
    }
    const r = await service.handoff('w1', { targetKey: 'codex', summarize: true })
    expect(sessions.prompts[0]?.[0]).toBe('w1')
    expect(shown[0]?.[1]).toMatch(/^Another coding agent is taking over/)
    expect(r.brief).toContain('## Summary by Claude Code · Personal\n## Goal\nRetry the payments client.')
    expect(r.summaryFailed).toBeUndefined()
  })

  it('falls back to the deterministic brief when the account is blocked or the turn fails', async () => {
    const blocked = setup({ budget: () => ({ action: 'block', window: '5h', percent: 100, ceiling: 90 }) })
    const r = await blocked.service.handoff('w1', { targetKey: 'codex', summarize: true })
    expect(blocked.sessions.prompts).toEqual([])
    expect(r.summaryFailed).toBe(true)
    expect(r.brief).toContain('## Last exchanges')
  })

  it('refuses a target the profile does not offer for a hand-off', async () => {
    const { service } = setup()
    await expect(service.handoff('w1', { targetKey: 'claude:laboral' })).rejects.toThrow(/cannot take this session over/)
  })
})

describe('claudeConfigDirOf', () => {
  it('resolves the account folder, then the agent and process env, then ~/.claude', () => {
    const config = makeConfig()
    expect(claudeConfigDirOf(config, laboral, '/home/u', {})).toBe(resolve('/tmp/wh-laboral'))
    expect(claudeConfigDirOf(config, personal, '/home/u', {})).toBe(resolve('/home/u/.claude'))
    expect(claudeConfigDirOf(config, null, '/home/u', { CLAUDE_CONFIG_DIR: '/tmp/x' })).toBe(resolve('/tmp/x'))
    expect(claudeConfigDirOf(config, { ...personal, env: { CLAUDE_CONFIG_DIR: '/tmp/y' } }, '/home/u', {})).toBe(resolve('/tmp/y'))
  })
})
