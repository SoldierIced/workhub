import { describe, expect, it } from 'vitest'
import { CONFIG_VERSION, NO_CAPABILITIES, type ResolvedReviewTarget, type ReviewTargetRequest, type SessionOrigin, type SessionState, type WorkhubConfig } from '@workhub/core'
import type { SessionView, StartSessionInput } from '../src/shared/api'
import { AgentReviewService, validAgentReviewRequest, type AgentReviewDeps } from '../src/main/agent-review'
import type { TargetResolution } from '@workhub/adapters/git-review'

function view(id: string, state: SessionState, over: Partial<SessionView> = {}): SessionView {
  return {
    id,
    identity: `ident-${id}`,
    agentId: 'claude',
    accountId: null,
    profileId: 'p',
    cwd: '/work/wayni',
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

const TARGET: ResolvedReviewTarget = {
  kind: 'commits',
  repoRoot: '/work/wayni/pay',
  repoName: 'pay',
  description: 'the commits `a..b` (`aaaaaaa..bbbbbbb`, 1 commit)',
  commits: ['bbbbbbb feat: refunds'],
  diffStat: 'src/refund.ts | 2 +-',
  diff: '+refund()\n'
}

function setup(over: { resolution?: TargetResolution; installed?: Record<string, boolean> } = {}) {
  const views: SessionView[] = [view('dev', 'ready', { name: 'Refunds in pay' })]
  const started: { input: StartSessionInput; env?: Record<string, string>; origin?: SessionOrigin }[] = []
  const prompts: [string, string][] = []
  const shown: [string, string][] = []
  const permissions: [string, string | null][] = []
  const placed: [string, string][] = []
  const resolved: ReviewTargetRequest[] = []
  const config: WorkhubConfig = { version: CONFIG_VERSION, connections: [], agents: [], accounts: [], profiles: [{ id: 'p', name: 'P', connections: {}, accountIds: [], modules: { flows: false, health: false, chatWatcher: false, automations: false } }], activeProfileId: 'p' }
  const deps: AgentReviewDeps = {
    config: async () => config,
    sessions: {
      list: () => views,
      start: async (input, internal) => {
        started.push({ input, ...(internal ?? {}) })
        const v = view(`rev${started.length}`, 'starting', { cwd: input.cwd, agentId: input.agentKey.split(':')[0]!, readOnly: true })
        views.push(v)
        setTimeout(() => {
          const i = views.indexOf(v)
          views[i] = { ...v, state: 'ready' }
        }, 1)
        return v
      },
      prompt: async (id, text) => {
        prompts.push([id, text])
        return 'end_turn'
      },
      respondPermission: (_id, req, option) => void permissions.push([req, option]),
      workPathsOf: () => ['/work/wayni/pay/src']
    },
    targets: {
      repositories: async () => [{ root: '/work/wayni/pay', name: 'pay', branch: 'feat/refunds', touched: true, dirtyFiles: 0 }],
      ghState: async () => 'signedOut',
      resolve: async (request) => {
        resolved.push(request)
        return over.resolution ?? { ok: true, inRepo: true, target: TARGET }
      }
    },
    remotes: async () => ['origin'],
    availability: async () => over.installed ?? { claude: true, kiro: true, codex: true },
    goal: async () => 'Make refunds idempotent',
    ticketPrefixes: () => ['PAY'],
    showPrompt: (id, text) => void shown.push([id, text]),
    placeBeside: async (member, anchor) => void placed.push([member.key, anchor])
  }
  const service = new AgentReviewService(deps)
  return { service, views, started, prompts, shown, permissions, placed, resolved }
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5))
}

describe('AgentReviewService', () => {
  it('offers the touched repositories, the gh state and another agent than the session own as reviewer', async () => {
    const { service } = setup()
    const o = await service.options('dev')
    expect(o?.repos.map((r) => r.name)).toEqual(['pay'])
    expect(o?.gh).toBe('signedOut')
    const reviewer = o?.reviewers.find((r) => r.key === o.defaultReviewerKey)
    expect(reviewer?.agentId).not.toBe('claude')
    expect(o?.reviewers.every((r) => r.adapter !== 'terminal')).toBe(true)
  })

  it('starts a read-only reviewer in the target repository with the full prompt, linked to the session', async () => {
    const { service, started, prompts, shown, placed } = setup()
    service.onEvent({ sessionId: 'dev', type: 'monitor', snapshot: { ticketKeys: ['PAY-7'] } })
    const r = await service.start('dev', { reviewerKey: 'kiro', target: { kind: 'commits', repo: '/work/wayni/pay', range: 'a..b' } })
    expect(r).toMatchObject({ ok: true, sessionId: 'rev1' })
    expect(started[0]?.input).toMatchObject({ agentKey: 'kiro', cwd: '/work/wayni/pay', readOnly: true, mode: 'app', profileId: 'p' })
    expect(started[0]?.origin).toEqual({ kind: 'review', fromLabel: 'Refunds in pay', fromIdentity: 'ident-dev' })
    // The reviewer cannot push.
    expect(Object.values(started[0]?.env ?? {})).toContain('remote.origin.pushurl')
    expect(placed).toEqual([['ident-rev1', 'ident-dev']])
    await until(() => prompts.length > 0)
    const prompt = prompts[0]![1]
    for (const part of ['Refunds in pay', 'Make refunds idempotent', 'PAY-7', '`pay` (`/work/wayni/pay`)', 'the commits `a..b`', '+refund()', 'file:line']) expect(prompt).toContain(part)
    expect(shown[0]).toEqual(['rev1', prompt])
  })

  it('refuses every permission the reviewer asks for', async () => {
    const { service, permissions } = setup()
    await service.start('dev', { reviewerKey: 'codex', target: { kind: 'branch', repo: '/work/wayni/pay' } })
    service.onEvent({ sessionId: 'rev1', type: 'permission', requestId: 'r1', title: 'Edit', options: [{ optionId: 'ok', name: 'Allow', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }] })
    expect(permissions).toEqual([['r1', 'no']])
  })

  it('starts a PR reviewer outside the repository in the session folder', async () => {
    const { service, started } = setup({ resolution: { ok: true, inRepo: false, target: { ...TARGET, kind: 'pr', repoRoot: '', repoName: 'acme/pay' } } })
    await service.start('dev', { reviewerKey: 'kiro', target: { kind: 'pr', pr: 'https://github.com/acme/pay/pull/1' } })
    expect(started[0]?.input.cwd).toBe('/work/wayni')
  })

  it('passes the target error on, and refuses a missing reviewer or a reviewer session', async () => {
    const a = setup({ resolution: { ok: false, reason: 'ghSignedOut' } })
    expect(await a.service.start('dev', { reviewerKey: 'kiro', target: { kind: 'pr', pr: '12', repo: '/work/wayni/pay' } })).toEqual({ ok: false, reason: 'ghSignedOut' })
    expect(a.started).toHaveLength(0)
    const b = setup({ installed: { kiro: false } })
    expect(await b.service.start('dev', { reviewerKey: 'kiro', target: { kind: 'branch', repo: '/work/wayni/pay' } })).toMatchObject({ ok: false, reason: 'reviewerMissing' })
    expect(await b.service.start('dev', { reviewerKey: 'nope', target: { kind: 'branch', repo: '/work/wayni/pay' } })).toEqual({ ok: false, reason: 'noReviewer' })
    b.views.push(view('rev9', 'ready', { readOnly: true }))
    expect(await b.service.start('rev9', { reviewerKey: 'codex', target: { kind: 'branch', repo: '/x' } })).toEqual({ ok: false, reason: 'reviewerSession' })
  })

  it('checks the renderer request field by field', () => {
    expect(validAgentReviewRequest({ reviewerKey: 'kiro', target: { kind: 'commits', repo: '/r', range: 'a..b' } })).toEqual({ reviewerKey: 'kiro', target: { kind: 'commits', repo: '/r', range: 'a..b' } })
    expect(validAgentReviewRequest({ reviewerKey: 'kiro', target: { kind: 'rm' } })).toBeNull()
    expect(validAgentReviewRequest({ target: { kind: 'branch', repo: '/r' } })).toBeNull()
  })
})
