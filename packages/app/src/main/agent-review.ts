/**
 * "Review with another agent" in the main process: the dialog's choices for a session (the
 * repositories it touched, the installed reviewer agents, whether `gh` can read pull requests),
 * and starting the reviewer as a read-only session of its own in the target's repository, with one
 * complete prompt, linked back to the session it reviews. Unlike the review loop (`ai-review.ts`)
 * nothing is parsed or sent back: the user reads the review in the reviewer's chat.
 */
import {
  aiReviewSettings,
  buildTargetReviewPrompt,
  defaultReviewer,
  pushBlockEnv,
  rejectOption,
  resolveEffectiveAgents,
  sessionIdentity,
  ticketKeysIn,
  type AgentEvent,
  type ReviewTargetRequest,
  type SessionOrigin,
  type WorkhubConfig
} from '@workhub/core'
import type { ReviewTargets } from '@workhub/adapters/git-review'
import type { SessionView, StartSessionInput } from '../shared/api'
import type { AgentReviewOptions, AgentReviewRequest, AgentReviewStartResult } from '../shared/ai-review-api'
import type { IpcRegistrar } from './ipc-guard'

export interface AgentReviewDeps {
  config: () => Promise<WorkhubConfig>
  sessions: {
    list(): SessionView[]
    start(input: StartSessionInput, internal?: { env?: Record<string, string>; origin?: SessionOrigin }): Promise<SessionView>
    prompt(id: string, text: string): Promise<string>
    respondPermission(id: string, requestId: string, optionId: string | null): void
    workPathsOf(id: string): string[] | undefined
  }
  targets: Pick<ReviewTargets, 'repositories' | 'ghState' | 'resolve'>
  /** The remotes of a repository, for the reviewer's push block. */
  remotes: (root: string) => Promise<string[]>
  /** Agent id -> whether its executable is installed. */
  availability: (config: WorkhubConfig) => Promise<Record<string, boolean>>
  /** The session's first request (its goal), from its transcript. */
  goal?: (view: SessionView) => Promise<string | undefined>
  ticketPrefixes?: (config: WorkhubConfig) => string[]
  /** Shows the prompt as a user message in the reviewer's chat. */
  showPrompt: (sessionId: string, text: string) => void
  /** Puts the reviewer next to the reviewed session in the sidebar. */
  placeBeside?: (member: { key: string; title: string; agentKey: string; cwd: string }, anchorKey: string) => Promise<void>
  startTimeoutMs?: number
  /** Diff size cut, in characters. */
  maxDiffChars?: number
}

const DEFAULT_MAX_DIFF = 150_000

export class AgentReviewService {
  /** Reviewer session ids: every permission they ask for is refused. */
  private readonly reviewers = new Set<string>()
  private readonly titles = new Map<string, string>()
  private readonly ticketKeys = new Map<string, string[]>()

  constructor(private readonly deps: AgentReviewDeps) {}

  onEvent(e: AgentEvent): void {
    if (this.reviewers.has(e.sessionId)) {
      if (e.type === 'permission') this.deps.sessions.respondPermission(e.sessionId, e.requestId, rejectOption(e.options) ?? null)
      return
    }
    if (e.type !== 'monitor') return
    if (e.snapshot.title) this.titles.set(e.sessionId, e.snapshot.title)
    if (e.snapshot.ticketKeys?.length) this.ticketKeys.set(e.sessionId, e.snapshot.ticketKeys)
  }

  private view(sessionId: string): SessionView | undefined {
    return this.deps.sessions.list().find((v) => v.id === sessionId)
  }

  /** What the dialog offers for a session. */
  async options(sessionId: string): Promise<AgentReviewOptions | null> {
    const view = this.view(sessionId)
    if (!view) return null
    const config = await this.deps.config()
    const profile = config.profiles.find((p) => p.id === (view.profileId ?? config.activeProfileId))
    const [repos, gh, installed] = await Promise.all([
      this.deps.targets.repositories(view.cwd, this.deps.sessions.workPathsOf(view.id) ?? []).catch(() => []),
      this.deps.targets.ghState(),
      this.deps.availability(config).catch(() => ({}) as Record<string, boolean>)
    ])
    const agents = resolveEffectiveAgents(config, profile?.id ?? null).filter((a) => a.agent.capabilities.appMode && a.agent.adapter !== 'terminal')
    const configured = aiReviewSettings(profile).reviewerAgent
    const fallback = defaultReviewer(agents, view.agentId, installed, [...(configured ? [configured] : []), ...(profile?.preferredAgents ?? [])])
    return {
      repos,
      reviewers: agents.map((a) => ({ key: a.key, label: a.label, agentId: a.agent.id, adapter: a.agent.adapter, installed: installed[a.agent.id] !== false })),
      ...(fallback ? { defaultReviewerKey: fallback.key } : {}),
      gh,
      baseBranch: aiReviewSettings(profile).baseBranch
    }
  }

  /** Resolves the target, builds the prompt and starts the reviewer; never throws. */
  async start(sessionId: string, request: AgentReviewRequest): Promise<AgentReviewStartResult> {
    const view = this.view(sessionId)
    if (!view) return { ok: false, reason: 'unknownSession' }
    if (view.readOnly) return { ok: false, reason: 'reviewerSession' }
    const config = await this.deps.config()
    const profile = config.profiles.find((p) => p.id === (view.profileId ?? config.activeProfileId))
    const reviewer = resolveEffectiveAgents(config, profile?.id ?? null).find((a) => a.key === request.reviewerKey)
    if (!reviewer || !reviewer.agent.capabilities.appMode || reviewer.agent.adapter === 'terminal') return { ok: false, reason: 'noReviewer' }
    const installed = await this.deps.availability(config).catch(() => ({}) as Record<string, boolean>)
    if (installed[reviewer.agent.id] === false) return { ok: false, reason: 'reviewerMissing', detail: reviewer.agent.command }

    const resolved = await this.deps.targets.resolve(request.target, aiReviewSettings(profile).baseBranch).catch((e: unknown) => ({ ok: false as const, reason: 'ghFailed' as const, detail: e instanceof Error ? e.message : String(e) }))
    if (!resolved.ok) return { ok: false, reason: resolved.reason, ...(resolved.detail ? { detail: resolved.detail } : {}) }
    const { target, inRepo } = resolved
    const cwd = inRepo ? target.repoRoot : view.cwd

    const goal = await withTimeout(this.deps.goal?.(view) ?? Promise.resolve(undefined), 10_000).catch(() => undefined)
    const prompt = buildTargetReviewPrompt({
      target,
      ...(view.name || this.titles.get(view.id) ? { sessionTitle: view.name ?? this.titles.get(view.id) } : {}),
      ...(goal ? { goal } : {}),
      ...(this.ticketOf(config, view, `${target.description} ${target.pr?.title ?? ''}`) ?? {}),
      inRepo,
      maxDiffChars: this.deps.maxDiffChars ?? DEFAULT_MAX_DIFF
    })

    // The reviewer cannot push: every remote gets an invalid push URL through its environment.
    const env = pushBlockEnv(inRepo ? await this.deps.remotes(cwd).catch(() => []) : [], process.env)
    const origin: SessionOrigin = { kind: 'review', fromLabel: view.name ?? view.label, fromIdentity: sessionIdentity(view) }
    let started: SessionView
    try {
      started = await this.deps.sessions.start({ profileId: view.profileId, agentKey: reviewer.key, cwd, mode: 'app', readOnly: true, cols: 120, rows: 32 }, { env, origin })
    } catch (e) {
      return { ok: false, reason: 'startFailed', detail: e instanceof Error ? e.message : String(e) }
    }
    this.reviewers.add(started.id)
    await this.deps
      .placeBeside?.({ key: sessionIdentity(started), title: started.agentName, agentKey: reviewer.key, cwd }, sessionIdentity(view))
      .catch(() => undefined)
    void this.send(started.id, prompt)
    return { ok: true, sessionId: started.id, description: target.description }
  }

  /** Sends the prompt once the reviewer is ready; a failure shows in the reviewer's own chat. */
  private async send(id: string, prompt: string): Promise<void> {
    const until = Date.now() + (this.deps.startTimeoutMs ?? 120_000)
    for (;;) {
      const v = this.view(id)
      if (!v || v.state === 'error' || v.state === 'stopped' || Date.now() > until) return
      if (v.state === 'ready') break
      await new Promise((r) => setTimeout(r, 200))
    }
    this.deps.showPrompt(id, prompt)
    await this.deps.sessions.prompt(id, prompt).catch(() => undefined)
  }

  /** The session's last ticket key, else one named in the target (its branch, the PR's title). */
  private ticketOf(config: WorkhubConfig, view: SessionView, targetText: string): { ticket: string } | null {
    const known = this.ticketKeys.get(view.id)?.at(-1)
    if (known) return { ticket: known }
    const prefixes = this.deps.ticketPrefixes?.(config) ?? []
    const key = prefixes.length ? ticketKeysIn(targetText.replace(/[/_]/g, ' '), [{ provider: 'jira', projectKeys: prefixes }])[0] : undefined
    return key ? { ticket: key } : null
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timed out')), ms)
    t.unref?.()
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e: unknown) => {
        clearTimeout(t)
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    )
  })
}

/** Checks the renderer's request field by field; null when it is not one. */
export function validAgentReviewRequest(input: unknown): AgentReviewRequest | null {
  if (!input || typeof input !== 'object') return null
  const o = input as Record<string, unknown>
  const t = o['target'] as Record<string, unknown> | undefined
  if (typeof o['reviewerKey'] !== 'string' || !t || typeof t !== 'object') return null
  const str = (k: string) => (typeof t[k] === 'string' ? (t[k] as string).slice(0, 2_000) : undefined)
  const repo = str('repo')
  let target: ReviewTargetRequest
  if (t['kind'] === 'uncommitted') target = { kind: 'uncommitted', repo: repo ?? '' }
  else if (t['kind'] === 'branch') target = { kind: 'branch', repo: repo ?? '', ...(str('base') ? { base: str('base')! } : {}) }
  else if (t['kind'] === 'pr') target = { kind: 'pr', pr: str('pr') ?? '', ...(repo ? { repo } : {}) }
  else if (t['kind'] === 'commits') target = { kind: 'commits', repo: repo ?? '', range: str('range') ?? '' }
  else return null
  return { reviewerKey: o['reviewerKey'], target }
}

export function registerAgentReviewIpc(ipc: IpcRegistrar, service: AgentReviewService): void {
  ipc.handle('agentReview:options', (_e, sessionId: string) => service.options(String(sessionId)))
  ipc.handle('agentReview:start', (_e, sessionId: string, request: unknown) => {
    const valid = validAgentReviewRequest(request)
    return valid ? service.start(String(sessionId), valid) : { ok: false, reason: 'badRequest' }
  })
}
