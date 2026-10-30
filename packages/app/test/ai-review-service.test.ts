import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { aiReviewSettings, CONFIG_VERSION, NO_CAPABILITIES, type AgentEvent, type AiReviewState, type BudgetStatus, type SessionState, type WorkhubConfig } from '@workhub/core'
import type { RepoProbe } from '@workhub/adapters/git-review'
import type { SessionView, StartSessionInput } from '../src/shared/api'
import type { AiReviewNotice } from '../src/shared/ai-review-api'
import { AiReviewService, reviewBudgetGate, type AiReviewDeps } from '../src/main/ai-review'
import { StateFile } from '../src/main/state-file'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function view(id: string, state: SessionState, over: Partial<SessionView> = {}): SessionView {
  return {
    id,
    identity: `ident-${id}`,
    agentId: 'claude',
    accountId: null,
    profileId: 'p',
    cwd: '/work/repo',
    state,
    permissionMode: null,
    startedAt: 1,
    label: 'Claude',
    agentName: 'Claude',
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

const REPLY = (findings: unknown[], extra: Record<string, unknown> = {}) => `Review done.\n\n\`\`\`json\n${JSON.stringify({ summary: 's', scope: { assessment: 'proportionate' }, findings, previous: [], escalate: { needed: false, reason: '' }, ...extra })}\n\`\`\``

function setup(opts: { budget?: BudgetStatus; reply?: string; modelIgnored?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'workhub-ai-review-'))
  dirs.push(dir)
  let now = 1_000_000
  const views: SessionView[] = [view('dev', 'ready')]
  const started: StartSessionInput[] = []
  const startedEnv: (Record<string, string> | undefined)[] = []
  const prompts: [string, string][] = []
  const delivered: [string, string][] = []
  const notices: AiReviewNotice[] = []
  const permissions: [string, string | null][] = []
  const stopped: string[] = []
  const renamed: [string, string | null][] = []
  let head = 'sha1'
  const config: WorkhubConfig = { version: CONFIG_VERSION, connections: [], agents: [], accounts: [], profiles: [{ id: 'p', name: 'P', connections: {}, accountIds: [], modules: { flows: false, health: false, chatWatcher: false, automations: false, flowMaps: false } }], activeProfileId: 'p' }
  let service!: AiReviewService
  const emit = (e: AgentEvent) => service.onEvent(e)
  const change = (id: string, state: SessionState) => {
    const i = views.findIndex((v) => v.id === id)
    views[i] = { ...views[i]!, state }
    service.onChanged(views[i]!)
  }
  let reply = opts.reply ?? REPLY([{ severity: 'blocker', title: 'Crash on empty list', file: 'src/a.ts', line: 3, why: 'index 0', fix: 'guard' }])
  const probe = async (): Promise<RepoProbe> => ({ root: '/work/repo', branch: 'feat/x', headSha: head, base: 'develop', baseRef: 'origin/develop', ahead: 2, dirty: false, dirtyFiles: [] })
  const deps: AiReviewDeps = {
    config: async () => config,
    sessions: {
      list: () => views,
      start: async (input, internal) => {
        started.push(input)
        startedEnv.push(internal?.env)
        const v = view(`rev${started.length}`, 'starting', { cwd: input.cwd, identity: `rev-ident-${started.length}`, ...(opts.modelIgnored ? { modelIgnored: true } : {}) })
        views.push(v)
        setTimeout(() => change(v.id, 'ready'), 1)
        return v
      },
      prompt: async (id, text) => {
        prompts.push([id, text])
        emit({ sessionId: id, type: 'permission', requestId: 'r1', title: 'Write file', options: [{ optionId: 'ok', name: 'Allow', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }] })
        emit({ sessionId: id, type: 'message', role: 'agent', text: reply.slice(0, 10) })
        emit({ sessionId: id, type: 'message', role: 'agent', text: reply.slice(10) })
        return 'end_turn'
      },
      stop: async (id) => void stopped.push(id),
      rename: (id, name) => void renamed.push([id, name]),
      respondPermission: (_id, _req, option) => void permissions.push([_req, option])
    },
    driver: {
      deliver: async (id, text) => (delivered.push([id, text]), 'delivered'),
      forget: async (id) => {
        const i = views.findIndex((v) => v.id === id)
        if (i >= 0) views.splice(i, 1)
      }
    },
    git: {
      probe: vi.fn(probe),
      refreshBase: vi.fn(async (): Promise<{ ok: true; remote: string } | { ok: false; reason: string }> => ({ ok: true, remote: 'origin' })),
      resolveBase: async () => ({ name: 'develop', ref: 'origin/develop' }),
      remotes: async () => ['origin', 'upstream'],
      mergeBase: async () => 'mb',
      isAncestor: async () => true,
      commits: async () => ['abc feat: x'],
      diffStat: async () => ' a.ts | 1 +',
      diff: async () => ({ text: '+x', truncated: false }),
      checkout: async () => undefined,
      remove: async () => undefined
    },
    state: new StateFile<AiReviewState>(join(dir, 'state.json'), 1),
    workDir: join(dir, 'ai-review'),
    emit: () => undefined,
    notice: (n) => void notices.push(n),
    showPrompt: () => undefined,
    now: () => now,
    ...(opts.budget ? { canStartReview: reviewBudgetGate(() => opts.budget!) } : {})
  }
  service = new AiReviewService(deps)
  return {
    service,
    views,
    started,
    startedEnv,
    config,
    prompts,
    delivered,
    notices,
    permissions,
    stopped,
    renamed,
    change,
    emit,
    deps,
    advance: (ms: number) => (now += ms),
    setHead: (sha: string) => (head = sha),
    setReply: (r: string) => (reply = r),
    settle: () => vi.waitFor(() => expect(service.snapshot().reviews.every((r) => r.status !== 'reviewing')).toBe(true))
  }
}

describe('AiReviewService', () => {
  it('reviews a dev session after its turn ends and the debounce passes, then sends the findings', async () => {
    const t = setup()
    t.change('dev', 'busy')
    t.change('dev', 'ready')
    await t.service.tick()
    expect(t.started).toHaveLength(0) // still inside the 60 s debounce
    t.advance(61_000)
    await t.service.tick()
    await vi.waitFor(() => expect(t.started).toHaveLength(1))
    expect(t.started[0]).toMatchObject({ agentKey: 'claude', readOnly: true, mode: 'app' })
    expect(t.started[0]!.cwd.startsWith(t.deps.workDir)).toBe(true)
    await t.settle()
    expect(t.prompts[0]![1]).toContain('feat/x')
    // The reviewer's request to write was refused, never allowed.
    expect(t.permissions).toEqual([['r1', 'no']])
    expect(t.stopped).toEqual(['rev1'])
    const review = t.service.snapshot().reviews[0]!
    expect(review).toMatchObject({ status: 'awaitingFixes', devSessionId: 'dev', lastReviewedSha: 'sha1' })
    expect(review.findings[0]).toMatchObject({ id: 'F1', severity: 'blocker', sent: true })
    expect(t.delivered).toHaveLength(1)
    expect(t.delivered[0]![1]).toContain('F1 [blocker] Crash on empty list')

    // The reviewer session is not a dev session: it never triggers a review of its own.
    t.advance(120_000)
    await t.service.tick()
    expect(t.started).toHaveLength(1)
  })

  it('skips automatic rounds for a session whose chat turned auto review off, keeps it across restarts, and still runs manual ones', async () => {
    const t = setup()
    t.service.setSessionAuto('dev', false)
    expect(t.service.snapshot().autoOff).toEqual(['ident-dev'])
    t.change('dev', 'busy')
    t.change('dev', 'ready')
    t.advance(61_000)
    await t.service.tick()
    expect(t.started).toHaveLength(0)
    t.deps.state.flush()
    expect(new AiReviewService(t.deps).snapshot().autoOff).toEqual(['ident-dev'])
    expect(await t.service.startManual('dev')).toMatchObject({ ok: true })
    await t.settle()
    t.service.setSessionAuto('dev', true)
    expect(t.service.snapshot().autoOff).toEqual([])
  })

  it('keeps the reviewer chat (stopped, named, linked from the round) and says who reviewed', async () => {
    const t = setup()
    expect(await t.service.startManual('dev')).toMatchObject({ ok: true })
    await t.settle()
    expect(t.stopped).toEqual(['rev1'])
    expect(t.views.some((v) => v.id === 'rev1')).toBe(true)
    expect(t.renamed).toEqual([['rev1', 'Review feat/x · round 1']])
    const round = t.service.snapshot().reviews[0]!.rounds[0]!
    expect(round).toMatchObject({ reviewerSessionId: 'rev1', reviewerLabel: 'Claude' })
    expect(t.delivered[0]![1]).toContain('Reviewed by Claude.')
  })

  it('writes the diff into the reviewer checkout and points the prompt at it instead of pasting it', async () => {
    const t = setup()
    let written = ''
    t.deps.sessions.prompt = async (id) => {
      written = readFileSync(join(t.deps.workDir, 'worktrees', 'ident-dev_feat_x', '.workhub-review', 'changes.diff'), 'utf8')
      return 'end_turn'
    }
    expect(await t.service.startManual('dev')).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(written).toBe('+x\n'))
  })

  it('marks a finding done when the dev agent replies FIXED, without dropping it', async () => {
    const t = setup()
    expect(await t.service.startManual('dev')).toMatchObject({ ok: true })
    await t.settle()
    t.change('dev', 'busy')
    t.emit({ sessionId: 'dev', type: 'message', role: 'agent', text: 'Committed.\nFIXED F1: guarded the empty list' })
    t.change('dev', 'ready')
    const review = t.service.snapshot().reviews[0]!
    expect(review.findings).toHaveLength(1)
    expect(review.findings[0]).toMatchObject({ status: 'fixed', fixedBy: 'dev', fixNote: 'guarded the empty list' })
  })

  it('pauses and tells the user when the dev agent disputes a finding', async () => {
    const t = setup()
    t.change('dev', 'busy')
    t.change('dev', 'ready')
    t.advance(61_000)
    await t.service.tick()
    await t.settle()
    t.change('dev', 'busy')
    t.emit({ sessionId: 'dev', type: 'message', role: 'agent', text: 'DISPUTE F1: the list is never empty here' })
    t.change('dev', 'ready')
    expect(t.service.snapshot().reviews[0]).toMatchObject({ status: 'paused', escalation: { reason: 'disputed' } })
    expect(t.notices).toContainEqual(expect.objectContaining({ kind: 'paused', reason: 'disputed', devSessionId: 'dev' }))
  })

  it('reviews the next commits in round 2 and becomes ready', async () => {
    const t = setup()
    t.change('dev', 'busy')
    t.change('dev', 'ready')
    t.advance(61_000)
    await t.service.tick()
    await t.settle()
    t.change('dev', 'busy')
    t.change('dev', 'ready')
    // No new commit: nothing happens.
    t.advance(61_000)
    await t.service.tick()
    expect(t.started).toHaveLength(1)
    t.setHead('sha2')
    t.setReply(REPLY([], { previous: [{ id: 'F1', status: 'fixed' }] }))
    t.advance(31_000)
    await t.service.tick()
    await vi.waitFor(() => expect(t.started).toHaveLength(2))
    await t.settle()
    expect(t.prompts[1]![1]).toContain('F1 [blocker]')
    expect(t.service.snapshot().reviews[0]).toMatchObject({ status: 'ready' })
    expect(t.notices).toContainEqual(expect.objectContaining({ kind: 'ready', branch: 'feat/x' }))
  })

  it('holds an automatic review past the usage budget and lets the user run it anyway', async () => {
    const t = setup({ budget: { action: 'block', window: '5h', percent: 97, ceiling: 90 } })
    t.change('dev', 'busy')
    t.change('dev', 'ready')
    t.advance(61_000)
    await t.service.tick()
    expect(t.started).toHaveLength(0)
    expect(t.service.snapshot().holds).toEqual([expect.objectContaining({ devIdentity: 'ident-dev', devSessionId: 'dev', budget: expect.objectContaining({ window: '5h' }) })])
    expect(t.notices).toEqual([expect.objectContaining({ kind: 'held' })])
    expect(await t.service.startManual('dev')).toEqual({ ok: false, reason: 'budget', detail: '5h' })
    expect(await t.service.startManual('dev', true)).toMatchObject({ ok: true })
    await t.settle()
    expect(t.service.snapshot().holds).toEqual([])
  })

  it('keeps an unreadable reply raw, pauses, and forwards it on Continue', async () => {
    const t = setup({ reply: 'I looked at it and it is fine, mostly.' })
    expect(await t.service.startManual('dev')).toMatchObject({ ok: true })
    await t.settle()
    const r = t.service.snapshot().reviews[0]!
    expect(r).toMatchObject({ status: 'paused', escalation: { reason: 'unparsed' } })
    expect(t.delivered).toHaveLength(0)
    await t.service.continue(r.id)
    expect(t.delivered[0]![1]).toContain('it is fine, mostly')
  })

  it('refuses a manual review on a reviewer session and outside a repository', async () => {
    const t = setup()
    ;(t.deps.git.probe as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null)
    expect(await t.service.startManual('dev')).toEqual({ ok: false, reason: 'notRepo' })
    expect(await t.service.startManual('nope')).toEqual({ ok: false, reason: 'unknownSession' })
  })

  it('fetches the base before every round and carries on with the local ref, saying so, when the fetch fails', async () => {
    const t = setup()
    const refresh = t.deps.git.refreshBase as ReturnType<typeof vi.fn>
    expect(await t.service.startManual('dev')).toMatchObject({ ok: true })
    await t.settle()
    expect(refresh).toHaveBeenCalledWith('/work/repo', 'develop')
    expect(t.service.snapshot().reviews[0]!.rounds[0]!.baseNote).toBeUndefined()

    refresh.mockResolvedValueOnce({ ok: false, reason: 'Could not resolve host: github.com' })
    t.setHead('sha2')
    expect(await t.service.startManual('dev')).toMatchObject({ ok: true })
    await t.settle()
    const review = t.service.snapshot().reviews[0]!
    expect(review.rounds[1]).toMatchObject({ baseNote: 'base not refreshed: Could not resolve host: github.com', parsed: true })
    expect(review.baseRef).toBe('origin/develop')
  })

  it('starts the reviewer with the profile\'s model and a push-blocking environment', async () => {
    const t = setup()
    t.config.profiles[0]!.aiReview = { ...aiReviewSettings(null), reviewerModel: ' claude-sonnet-4-5 ' }
    expect(await t.service.startManual('dev')).toMatchObject({ ok: true })
    await t.settle()
    expect(t.started[0]!.model).toBe('claude-sonnet-4-5')
    expect(t.startedEnv[0]).toMatchObject({ GIT_CONFIG_KEY_0: 'remote.origin.pushurl', GIT_CONFIG_KEY_1: 'remote.upstream.pushurl' })
    expect(t.service.snapshot().reviews[0]!.rounds[0]!.modelNote).toBeUndefined()
  })

  it('sends no model by default, and notes it when the agent could not apply the one asked', async () => {
    const plain = setup()
    await plain.service.startManual('dev')
    await plain.settle()
    expect(plain.started[0]).not.toHaveProperty('model')

    const t = setup({ modelIgnored: true })
    t.config.profiles[0]!.aiReview = { ...aiReviewSettings(null), reviewerModel: 'gpt-x' }
    await t.service.startManual('dev')
    await t.settle()
    expect(t.service.snapshot().reviews[0]!.rounds[0]!.modelNote).toContain('"gpt-x" not applied')
  })

  it('restarts automatic rounds on new commits after Ready, reviewing only the delta, with a fresh round budget', async () => {
    const t = setup({ reply: REPLY([]) })
    t.change('dev', 'busy')
    t.change('dev', 'ready')
    t.advance(61_000)
    await t.service.tick()
    await t.settle()
    expect(t.service.snapshot().reviews[0]).toMatchObject({ status: 'ready', lastReviewedSha: 'sha1' })

    // Ready holds while the branch does not move.
    t.change('dev', 'busy')
    t.change('dev', 'ready')
    t.advance(61_000)
    await t.service.tick()
    expect(t.started).toHaveLength(1)

    // A new commit after Ready starts a new cycle by itself.
    t.setHead('sha2')
    t.change('dev', 'busy')
    t.change('dev', 'ready')
    t.advance(61_000)
    await t.service.tick()
    await vi.waitFor(() => expect(t.started).toHaveLength(2))
    await t.settle()
    const review = t.service.snapshot().reviews[0]!
    expect(review.rounds.map((r) => [r.n, r.sha, r.fromSha])).toEqual([[1, 'sha1', undefined], [2, 'sha2', 'sha1']])
    expect(review).toMatchObject({ status: 'ready', cycleStart: 1, lastReviewedSha: 'sha2' })
    expect(t.prompts[1]![1]).toContain('Round 1: the author pushed new commits')
    expect(t.prompts[1]![1]).toContain('sha1')
  })
})
