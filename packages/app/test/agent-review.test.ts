import { describe, expect, it } from 'vitest'
import { CONFIG_VERSION, NO_CAPABILITIES, type BudgetStatus, type SessionOrigin, type SessionState, type WorkhubConfig } from '@workhub/core'
import type { SessionView, StartSessionInput } from '../src/shared/api'
import type { ReviewLoopView } from '../src/shared/ai-review-api'
import { AgentReviewService, validAgentReviewRequest, type AgentReviewDeps } from '../src/main/agent-review'

function view(id: string, state: SessionState, over: Partial<SessionView> = {}): SessionView {
  return {
    id,
    identity: `ident-${id}`,
    agentId: 'claude',
    accountId: null,
    profileId: 'p',
    cwd: '/work/acme',
    state,
    permissionMode: null,
    startedAt: 1,
    label: 'Claude Code',
    agentName: 'Claude Code',
    adapter: 'native',
    capabilities: { ...NO_CAPABILITIES, appMode: true },
    screens: [],
    modes: ['app'],
    mode: 'app',
    shellRunning: false,
    controls: false,
    ...over
  }
}

/**
 * What a fake agent does with its next prompt: answer with a text, keep the turn running until it
 * is cancelled (`hang`), end it as cancelled in its chat (`cancel`), or die mid-turn (`crash`).
 */
type Step = string | { hang: true } | { cancel: true } | { crash: true }

const BRIEF = 'Sure.\n<review-brief>\nRepos: /work/acme/pay on feat/refunds; diff: git -C /work/acme/pay diff develop...feat/refunds\n</review-brief>'
const CHANGES = '1. major: src/refund.ts:12 refunds twice.\nVERDICT: CHANGES_REQUESTED'
const APPROVED = 'All fixed.\nVERDICT: APPROVED'

function setup(script: { author?: Step[]; reviewer?: Step[]; installed?: Record<string, boolean>; budget?: BudgetStatus } = {}) {
  const views: SessionView[] = [view('dev', 'ready', { name: 'Refunds in pay' })]
  const author = [...(script.author ?? [])]
  const reviewer = [...(script.reviewer ?? [])]
  const started: { input: StartSessionInput; env?: Record<string, string>; origin?: SessionOrigin }[] = []
  const prompts: [string, string][] = []
  const shown: [string, string][] = []
  const turnEnds: [string, string][] = []
  const cancelled: string[] = []
  const permissions: [string, string | null][] = []
  const placed: [string, string][] = []
  const emitted: ReviewLoopView[][] = []
  const hanging = new Map<string, (stopReason: string) => void>()
  const config: WorkhubConfig = { version: CONFIG_VERSION, connections: [], agents: [], accounts: [], profiles: [{ id: 'p', name: 'P', connections: {}, accountIds: [], modules: { flows: false, health: false, chatWatcher: false, automations: false } }], activeProfileId: 'p' }
  const setState = (id: string, state: SessionState) => {
    const i = views.findIndex((v) => v.id === id)
    views[i] = { ...views[i]!, state }
  }
  const deps: AgentReviewDeps = {
    config: async () => config,
    sessions: {
      list: () => views,
      start: async (input, internal) => {
        started.push({ input, ...(internal ?? {}) })
        const v = view(`rev${started.length}`, 'starting', { cwd: input.cwd, agentId: input.agentKey.split(':')[0]!, readOnly: true })
        views.push(v)
        setTimeout(() => setState(v.id, 'ready'), 1)
        return v
      },
      prompt: (id, text) => {
        prompts.push([id, text])
        const step = (id === 'dev' ? author : reviewer).shift() ?? 'ok'
        return new Promise<string>((resolve) => {
          setTimeout(() => {
            if (typeof step === 'string') {
              service.onEvent({ sessionId: id, type: 'message', role: 'agent', text: step })
              resolve('end_turn')
            } else if ('hang' in step) hanging.set(id, resolve)
            else if ('cancel' in step) resolve('cancelled')
            else setState(id, 'error')
          }, 1)
        })
      },
      cancel: async (id) => {
        cancelled.push(id)
        hanging.get(id)?.('cancelled')
      },
      respondPermission: (_id, req, option) => void permissions.push([req, option])
    },
    remotes: async () => ['origin', 'upstream'],
    availability: async () => script.installed ?? { claude: true, kiro: true, codex: true },
    ...(script.budget ? { budget: () => script.budget! } : {}),
    showPrompt: (id, text) => void shown.push([id, text]),
    showTurnEnd: (id, stopReason) => void turnEnds.push([id, stopReason]),
    placeBeside: async (member, anchor) => void placed.push([member.key, anchor]),
    emit: (loops) => void emitted.push(loops),
    pollMs: 2
  }
  const service = new AgentReviewService(deps)
  const loop = () => service.snapshot()[0]
  return { service, views, started, prompts, shown, turnEnds, cancelled, permissions, placed, emitted, hanging, loop }
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 400 && !check(); i++) await new Promise((r) => setTimeout(r, 5))
  expect(check()).toBe(true)
}
const ended = (l: ReviewLoopView | undefined) => l !== undefined && ['approved', 'maxRounds', 'stopped', 'failed'].includes(l.phase)

const request = { reviewerKey: 'kiro', prompt: 'Write the brief.', maxRounds: 3 }

describe('AgentReviewService', () => {
  it('offers another agent than the session own as reviewer, the default brief prompt and the round limit', async () => {
    const { service } = setup()
    const o = await service.options('dev')
    expect(o?.reviewers.find((r) => r.key === o.defaultReviewerKey)?.agentId).not.toBe('claude')
    expect(o?.reviewers.every((r) => r.adapter !== 'terminal')).toBe(true)
    expect(o?.briefPrompt).toContain('<review-brief>')
    expect(o?.maxRounds).toBe(3)
  })

  it('approves on round 1: the author briefs, a linked read-only reviewer reviews, both chats show it', async () => {
    const s = setup({ author: [BRIEF], reviewer: [APPROVED] })
    expect(await s.service.start('dev', request)).toMatchObject({ ok: true })
    await until(() => ended(s.loop()))
    expect(s.loop()).toMatchObject({ phase: 'approved', round: 1, reviewerSessionId: 'rev1', reviewerLabel: expect.stringContaining('Kiro') })
    // The prompt went to the author as typed, then the brief to the reviewer.
    expect(s.prompts.map(([id]) => id)).toEqual(['dev', 'rev1'])
    expect(s.prompts[0]![1]).toBe('Write the brief.')
    const first = s.prompts[1]![1]
    expect(first.split('\n')[0]).toBe('Review: Refunds in pay')
    expect(first).toContain('git -C /work/acme/pay diff develop...feat/refunds')
    expect(first).not.toContain('Sure.')
    expect(s.shown).toEqual(s.prompts)
    expect(s.turnEnds).toEqual([['dev', 'end_turn'], ['rev1', 'end_turn']])
    expect(s.started[0]?.input).toMatchObject({ agentKey: 'kiro', cwd: '/work/acme', readOnly: true, mode: 'app', profileId: 'p' })
    expect(s.started[0]?.origin).toEqual({ kind: 'review', fromLabel: 'Refunds in pay', fromIdentity: 'ident-dev' })
    // The reviewer cannot push.
    expect(Object.values(s.started[0]?.env ?? {})).toEqual(expect.arrayContaining(['remote.origin.pushurl', 'remote.upstream.pushurl']))
    expect(s.placed).toEqual([['ident-rev1', 'ident-dev']])
    expect(s.emitted.at(-1)?.[0]?.phase).toBe('approved')
  })

  it('relays changes to the author and its answer back to the reviewer until it approves', async () => {
    const s = setup({ author: [BRIEF, 'Fixed src/refund.ts:12 in abc123.'], reviewer: [CHANGES, APPROVED] })
    await s.service.start('dev', request)
    await until(() => ended(s.loop()))
    expect(s.loop()).toMatchObject({ phase: 'approved', round: 2 })
    expect(s.prompts.map(([id]) => id)).toEqual(['dev', 'rev1', 'dev', 'rev1'])
    expect(s.prompts[2]![1]).toContain('Review round 1 of 3')
    expect(s.prompts[2]![1]).toContain('src/refund.ts:12 refunds twice')
    expect(s.prompts[3]![1]).toContain('Fixed src/refund.ts:12 in abc123.')
    expect(s.prompts[3]![1]).toContain('round 2 of at most 3')
  })

  it('stops at the round limit while the reviewer still requests changes', async () => {
    const s = setup({ author: [BRIEF, 'fix 1'], reviewer: [CHANGES, CHANGES, APPROVED] })
    await s.service.start('dev', { ...request, maxRounds: 2 })
    await until(() => ended(s.loop()))
    expect(s.loop()).toMatchObject({ phase: 'maxRounds', round: 2 })
    // The last findings stay in the reviewer's chat: nothing more goes to the author.
    expect(s.prompts.map(([id]) => id)).toEqual(['dev', 'rev1', 'dev', 'rev1'])
  })

  it('stops when the user presses Stop: the turn it waits on is interrupted and nothing more is sent', async () => {
    const s = setup({ author: [BRIEF, { hang: true }], reviewer: [CHANGES] })
    await s.service.start('dev', request)
    await until(() => s.loop()?.phase === 'fixing' && s.hanging.has('dev'))
    await s.service.stop(s.loop()!.id)
    await until(() => s.turnEnds.length === 3)
    expect(s.loop()).toMatchObject({ phase: 'stopped', stoppedBy: 'user' })
    expect(s.cancelled).toEqual(['dev'])
    await new Promise((r) => setTimeout(r, 20))
    expect(s.prompts).toHaveLength(3)
  })

  it('stops when a turn of the loop is cancelled in a chat', async () => {
    const s = setup({ author: [BRIEF], reviewer: [{ cancel: true }] })
    await s.service.start('dev', request)
    await until(() => ended(s.loop()))
    expect(s.loop()).toMatchObject({ phase: 'stopped', stoppedBy: 'cancelled' })
  })

  it('fails when the author session closes mid-turn', async () => {
    const s = setup({ author: [BRIEF, { crash: true }], reviewer: [CHANGES] })
    await s.service.start('dev', request)
    await until(() => ended(s.loop()))
    expect(s.loop()).toMatchObject({ phase: 'failed', failure: 'authorClosed', round: 1 })
    expect(s.prompts).toHaveLength(3)
  })

  it('fails without starting a reviewer when the author writes no brief', async () => {
    const s = setup({ author: [' '] })
    await s.service.start('dev', request)
    await until(() => ended(s.loop()))
    expect(s.loop()).toMatchObject({ phase: 'failed', failure: 'noBrief' })
    expect(s.started).toHaveLength(0)
  })

  it('refuses every permission the reviewer asks for', async () => {
    const s = setup({ author: [BRIEF], reviewer: [{ hang: true }] })
    await s.service.start('dev', request)
    await until(() => s.prompts.length === 2)
    s.service.onEvent({ sessionId: 'rev1', type: 'permission', requestId: 'r1', title: 'Edit', options: [{ optionId: 'ok', name: 'Allow', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }] })
    expect(s.permissions).toEqual([['r1', 'no']])
  })

  it('refuses a missing reviewer, a reviewer session, a busy author, a second loop and a usage budget', async () => {
    const a = setup({ installed: { kiro: false }, author: [{ hang: true }] })
    expect(await a.service.start('dev', request)).toMatchObject({ ok: false, reason: 'reviewerMissing' })
    expect(await a.service.start('dev', { ...request, reviewerKey: 'nope' })).toEqual({ ok: false, reason: 'noReviewer' })
    a.views.push(view('rev9', 'ready', { readOnly: true }))
    expect(await a.service.start('rev9', { ...request, reviewerKey: 'codex' })).toEqual({ ok: false, reason: 'reviewerSession' })
    expect(await a.service.start('dev', { ...request, reviewerKey: 'codex' })).toMatchObject({ ok: true })
    expect(await a.service.start('dev', { ...request, reviewerKey: 'codex' })).toEqual({ ok: false, reason: 'running' })
    a.views.push(view('busy', 'busy'))
    expect(await a.service.start('busy', { ...request, reviewerKey: 'codex' })).toEqual({ ok: false, reason: 'authorBusy' })

    const budget: BudgetStatus = { action: 'block', window: 'five_hour', percent: 95, ceiling: 90 } as BudgetStatus
    const b = setup({ budget, author: [BRIEF], reviewer: [APPROVED] })
    expect(await b.service.start('dev', request)).toEqual({ ok: false, reason: 'budget', detail: 'five_hour' })
    expect(await b.service.start('dev', { ...request, override: true })).toMatchObject({ ok: true })
    await until(() => ended(b.loop()))
    expect(b.loop()?.phase).toBe('approved')
  })

  it('checks the renderer request field by field', () => {
    expect(validAgentReviewRequest({ reviewerKey: 'kiro', prompt: 'Brief', maxRounds: 40 })).toEqual({ reviewerKey: 'kiro', prompt: 'Brief', maxRounds: 10 })
    expect(validAgentReviewRequest({ reviewerKey: 'kiro', prompt: 'Brief', maxRounds: 2, override: true })).toEqual({ reviewerKey: 'kiro', prompt: 'Brief', maxRounds: 2, override: true })
    expect(validAgentReviewRequest({ reviewerKey: 'kiro', prompt: ' ', maxRounds: 3 })).toBeNull()
    expect(validAgentReviewRequest({ reviewerKey: 'kiro', prompt: 'Brief' })).toBeNull()
    expect(validAgentReviewRequest({ prompt: 'Brief', maxRounds: 3 })).toBeNull()
  })
})
