import {
  chooseFolderForPullRequest,
  effectiveAgentKey,
  pickAgent,
  prName,
  sessionsForPullRequest,
  ticketKeysIn,
  type Checkout,
  type EffectiveAgent,
  type LinkableSession,
  type Profile,
  type PromptOverrides,
  type SessionState,
  type TicketKeyProvider
} from '@workhub/core'
import type { HistoryItem, StartSessionInput } from '@shared/api'
import type { PullRequestTarget, SessionIntent, TicketTarget } from '@shared/links-api'
import type { Locale, MessageKey, Params } from '../i18n/translate'
import type { SessionData } from '../store'
import { errorText } from './errorText'
import { draftPrompt } from './promptText'

/** Prompt drafted for "Ask Claude to review". It goes into the composer; the app never sends it. */
export function reviewPrompt(locale: Locale, pr: PullRequestTarget, overrides?: PromptOverrides): string {
  return draftPrompt(overrides, 'links.reviewPr', locale, 'links.prompt.review', { name: prName(pr, pr.provider), title: pr.title, url: pr.url, branch: pr.branch, base: pr.base, author: pr.author })
}

/** Prompt drafted for "Start session about this ticket" (key, title and link). Never sent by the app. */
export function ticketPrompt(locale: Locale, ticket: TicketTarget, overrides?: PromptOverrides): string {
  const params = { key: ticket.key, title: ticket.title, url: ticket.url ?? '' }
  return ticket.url ? draftPrompt(overrides, 'links.ticket', locale, 'links.prompt.ticket', params) : draftPrompt(overrides, 'links.ticketNoUrl', locale, 'links.prompt.ticketNoUrl', params)
}

const isLive = (s: SessionData): boolean => s.view.state !== 'stopped' && s.view.state !== 'error'

/** A live session as the PR matcher sees it: the PRs and tickets its monitor found, plus keys in its label. */
export function linkableSessions(sessions: readonly SessionData[], providers: readonly TicketKeyProvider[]): LinkableSession[] {
  return sessions.filter(isLive).map((s) => ({
    id: s.view.id,
    pullRequestUrls: s.monitor.pullRequests,
    ticketKeys: [...new Set([...(s.monitor.ticketKeys ?? []), ...ticketKeysIn(s.view.label, providers)])]
  }))
}

/** The live session to show for a PR: the strongest link (URL, then ticket); undefined when none. */
export function liveSessionForPullRequest(pr: Pick<PullRequestTarget, 'url' | 'title' | 'branch'>, sessions: readonly SessionData[], providers: readonly TicketKeyProvider[]): string | undefined {
  return sessionsForPullRequest(pr, linkableSessions(sessions, providers), providers)[0]?.sessionId
}

/** The agent for a session about a PR or ticket: the user's preferred one, else Claude, else the first with an app mode (drafts need the chat). */
export function agentForDraft(profile: Pick<Profile, 'preferredAgents'> | undefined, agents: readonly EffectiveAgent[], claudeOnly: boolean): EffectiveAgent | undefined {
  return pickAgent(profile, agents, claudeOnly ? 'claude' : 'appMode')
}

/** The start request that reopens a past session (the History screen's resume, shared with the PR and ticket windows). */
export async function resumeInput(profileId: string | null, e: HistoryItem, mode: 'app' | 'console', model: (agentKey: string) => string | undefined, defaultCwd: () => Promise<string>): Promise<StartSessionInput> {
  const agentKey = effectiveAgentKey(e.agentId, e.accountId)
  return { profileId, agentKey, cwd: e.cwd || (await defaultCwd()), mode, resumeAgentSessionId: e.agentSessionId, model: model(agentKey), cols: 100, rows: 30 }
}

export type PullRequestPromptIntent = Extract<SessionIntent, { kind: 'pullRequestPrompt' }>

export type IntentOutcome =
  | { kind: 'opened'; sessionId: string }
  | { kind: 'started'; sessionId: string; folder: string; drafted: boolean }
  | { kind: 'sent'; sessionId: string; started?: { folder: string } }
  /** No session is linked to the PR: the user is asked before one starts in `folder`. */
  | { kind: 'offer'; intent: PullRequestPromptIntent; folder: string; onBranch: boolean }
  | { kind: 'error'; message: MessageKey; params?: Params }

/** The things an intent needs from the app; injected so the logic runs (and is tested) without Electron. */
export interface IntentDeps {
  locale: Locale
  /** The user's own prompt texts (Settings → Prompts), read when the intent is carried out. */
  overrides?: PromptOverrides
  agents: readonly EffectiveAgent[]
  /** The active profile, for its preferred agent order. */
  profile?: Pick<Profile, 'preferredAgents'>
  sessions: readonly SessionData[]
  checkouts: (profileId: string | null) => Promise<Checkout[]>
  providers: (profileId: string | null) => Promise<TicketKeyProvider[]>
  defaultCwd: () => Promise<string>
  model: (agentKey: string) => string | undefined
  start: (input: StartSessionInput) => Promise<{ id: string; state?: SessionState }>
  /** Puts text in the composer of a session. It must never send it. */
  setDraft: (sessionId: string, text: string) => void
  /**
   * Sends a prompt the user asked for with a click ("Fix CI"): straight away, or queued until the
   * session is ready. False when the session takes no messages. Only `pullRequestPrompt` uses it.
   */
  send?: (sessionId: string, text: string, state: SessionState) => boolean
}

const failure = (message: MessageKey, params?: Params): IntentOutcome => ({ kind: 'error', message, params })

async function startDrafted(deps: IntentDeps, profileId: string | null, agent: EffectiveAgent, cwd: string, text: string): Promise<IntentOutcome> {
  const view = await deps.start({ profileId, agentKey: agent.key, cwd, cols: 100, rows: 30, mode: 'app', model: deps.model(agent.key) })
  deps.setDraft(view.id, text)
  return { kind: 'started', sessionId: view.id, folder: cwd, drafted: true }
}

/**
 * "Fix CI" / "Address review comments": the prompt goes to the live session linked to the PR.
 * Without one, a session starts in the PR's repository folder only once the user agreed (`start`);
 * a folder that is not the PR's repository is never picked.
 */
async function promptPullRequest(deps: IntentDeps, intent: PullRequestPromptIntent): Promise<IntentOutcome> {
  const { pr, prompt, profileId } = intent
  const send = deps.send
  if (!send) return failure('prFeedback.notSent')
  const live = liveSessionForPullRequest(pr, deps.sessions, await deps.providers(profileId))
  if (live) {
    const state = deps.sessions.find((s) => s.view.id === live)!.view.state
    return send(live, prompt, state) ? { kind: 'sent', sessionId: live } : failure('prFeedback.notSent')
  }
  const choice = chooseFolderForPullRequest(pr, await deps.checkouts(profileId))
  if (!choice.path || (choice.reason !== 'branch' && choice.reason !== 'repo' && choice.reason !== 'name')) return failure('prFeedback.noFolder', { repo: `${pr.owner}/${pr.repo}` })
  if (!intent.start) return { kind: 'offer', intent, folder: choice.path, onBranch: choice.reason === 'branch' }
  const agent = agentForDraft(deps.profile, deps.agents, false)
  if (!agent) return failure('links.noAgent')
  const view = await deps.start({ profileId, agentKey: agent.key, cwd: choice.path, cols: 100, rows: 30, mode: 'app', model: deps.model(agent.key) })
  if (!send(view.id, prompt, view.state ?? 'starting')) return failure('prFeedback.notSent')
  return { kind: 'sent', sessionId: view.id, started: { folder: choice.path } }
}

/** Carries out one intent. Starting is the only side effect besides the draft; only `pullRequestPrompt` (a click on its button) sends a prompt. */
export async function runIntent(deps: IntentDeps, intent: SessionIntent): Promise<IntentOutcome> {
  try {
    if (intent.kind === 'pullRequestPrompt') return await promptPullRequest(deps, intent)
    if (intent.kind === 'resume') {
      const view = await deps.start(await resumeInput(intent.profileId, intent.entry, intent.mode, deps.model, deps.defaultCwd))
      return { kind: 'opened', sessionId: view.id }
    }
    if (intent.kind === 'ticketSession') {
      const claude = intent.agent === 'claude'
      const agent = agentForDraft(deps.profile, deps.agents, claude)
      if (!agent) return failure(claude ? 'links.noClaude' : 'links.noAgent')
      const cwd = chooseFirstFolder(await deps.checkouts(intent.profileId)) ?? (await deps.defaultCwd())
      return await startDrafted(deps, intent.profileId, agent, cwd, ticketPrompt(deps.locale, intent.ticket, deps.overrides))
    }
    const { pr } = intent
    if (intent.kind === 'pullRequestSession') {
      const live = liveSessionForPullRequest(pr, deps.sessions, await deps.providers(intent.profileId))
      if (live) return { kind: 'opened', sessionId: live }
    }
    const review = intent.kind === 'reviewPullRequest'
    const agent = agentForDraft(deps.profile, deps.agents, review) ?? (review ? undefined : deps.agents[0])
    if (!agent) return failure(review ? 'links.noClaude' : 'links.noAgent')
    const cwd = chooseFolderForPullRequest(pr, await deps.checkouts(intent.profileId)).path ?? (await deps.defaultCwd())
    if (review) return await startDrafted(deps, intent.profileId, agent, cwd, reviewPrompt(deps.locale, pr, deps.overrides))
    const view = await deps.start({ profileId: intent.profileId, agentKey: agent.key, cwd, cols: 100, rows: 30, model: deps.model(agent.key) })
    return { kind: 'started', sessionId: view.id, folder: cwd, drafted: false }
  } catch (e) {
    return failure('links.failed', { message: errorText(e) })
  }
}

const chooseFirstFolder = (checkouts: readonly Checkout[]): string | undefined => checkouts[0]?.path
