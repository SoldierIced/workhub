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
  type TicketKeyProvider
} from '@workhub/core'
import type { HistoryItem, StartSessionInput } from '@shared/api'
import type { PullRequestTarget, SessionIntent, TicketTarget } from '@shared/links-api'
import { translate, type Locale, type MessageKey, type Params } from '../i18n/translate'
import type { SessionData } from '../store'
import { errorText } from './errorText'

/** Prompt drafted for "Ask Claude to review". It goes into the composer; the app never sends it. */
export function reviewPrompt(locale: Locale, pr: PullRequestTarget): string {
  return translate(locale, 'links.prompt.review', { name: prName(pr, pr.provider), title: pr.title, url: pr.url, branch: pr.branch, base: pr.base, author: pr.author })
}

/** Prompt drafted for "Start session about this ticket" (key, title and link). Never sent by the app. */
export function ticketPrompt(locale: Locale, ticket: TicketTarget): string {
  const params = { key: ticket.key, title: ticket.title, url: ticket.url ?? '' }
  return translate(locale, ticket.url ? 'links.prompt.ticket' : 'links.prompt.ticketNoUrl', params)
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

export type IntentOutcome =
  | { kind: 'opened'; sessionId: string }
  | { kind: 'started'; sessionId: string; folder: string; drafted: boolean }
  | { kind: 'error'; message: MessageKey; params?: Params }

/** The things an intent needs from the app; injected so the logic runs (and is tested) without Electron. */
export interface IntentDeps {
  locale: Locale
  agents: readonly EffectiveAgent[]
  /** The active profile, for its preferred agent order. */
  profile?: Pick<Profile, 'preferredAgents'>
  sessions: readonly SessionData[]
  checkouts: (profileId: string | null) => Promise<Checkout[]>
  providers: (profileId: string | null) => Promise<TicketKeyProvider[]>
  defaultCwd: () => Promise<string>
  model: (agentKey: string) => string | undefined
  start: (input: StartSessionInput) => Promise<{ id: string }>
  /** Puts text in the composer of a session. It must never send it. */
  setDraft: (sessionId: string, text: string) => void
}

const failure = (message: MessageKey, params?: Params): IntentOutcome => ({ kind: 'error', message, params })

async function startDrafted(deps: IntentDeps, profileId: string | null, agent: EffectiveAgent, cwd: string, text: string): Promise<IntentOutcome> {
  const view = await deps.start({ profileId, agentKey: agent.key, cwd, cols: 100, rows: 30, mode: 'app', model: deps.model(agent.key) })
  deps.setDraft(view.id, text)
  return { kind: 'started', sessionId: view.id, folder: cwd, drafted: true }
}

/** Carries out one intent. Starting is the only side effect besides the draft; no prompt is ever sent. */
export async function runIntent(deps: IntentDeps, intent: SessionIntent): Promise<IntentOutcome> {
  try {
    if (intent.kind === 'resume') {
      const view = await deps.start(await resumeInput(intent.profileId, intent.entry, intent.mode, deps.model, deps.defaultCwd))
      return { kind: 'opened', sessionId: view.id }
    }
    if (intent.kind === 'ticketSession') {
      const claude = intent.agent === 'claude'
      const agent = agentForDraft(deps.profile, deps.agents, claude)
      if (!agent) return failure(claude ? 'links.noClaude' : 'links.noAgent')
      const cwd = chooseFirstFolder(await deps.checkouts(intent.profileId)) ?? (await deps.defaultCwd())
      return await startDrafted(deps, intent.profileId, agent, cwd, ticketPrompt(deps.locale, intent.ticket))
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
    if (review) return await startDrafted(deps, intent.profileId, agent, cwd, reviewPrompt(deps.locale, pr))
    const view = await deps.start({ profileId: intent.profileId, agentKey: agent.key, cwd, cols: 100, rows: 30, model: deps.model(agent.key) })
    return { kind: 'started', sessionId: view.id, folder: cwd, drafted: false }
  } catch (e) {
    return failure('links.failed', { message: errorText(e) })
  }
}

const chooseFirstFolder = (checkouts: readonly Checkout[]): string | undefined => checkouts[0]?.path
