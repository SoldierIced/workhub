import {
  aggregateAttention,
  EMPTY_SESSION_GROUPS,
  effectiveAgentKey,
  reconcileTop,
  sessionIdentity,
  type AttentionSummary,
  type GroupMember,
  type SessionGroups
} from '@workhub/core'
import { refreshConfig } from '../configStore'
import { awaitingAnswer, type SessionData } from '../store'
import { folderName } from './home'

/** A session as the sidebar lists it, with the identity groups know it by. */
export interface ListedSession {
  key: string
  data: SessionData
}

const isLive = (s: SessionData): boolean => s.view.state !== 'stopped' && s.view.state !== 'error'

/**
 * One entry per identity: a session reopened (resumed from History, or from its group) replaces
 * the stopped one it continues, so a conversation is never listed twice. Oldest first, which is
 * where new sessions are added in the list.
 */
export function listSessions(all: readonly SessionData[]): ListedSession[] {
  const best = new Map<string, SessionData>()
  for (const s of all) {
    const key = sessionIdentity(s.view)
    const prev = best.get(key)
    if (!prev || (isLive(s) && !isLive(prev)) || (isLive(s) === isLive(prev) && s.view.startedAt >= prev.view.startedAt)) best.set(key, s)
  }
  return [...best.entries()].map(([key, data]) => ({ key, data })).sort((a, b) => a.data.view.startedAt - b.data.view.startedAt)
}

const NAME_MAX = 60

/**
 * What the sidebar calls a session: the name the user gave it (Rename…), else the first line of
 * what the user first asked, else its folder. The agent and the account are shown by the row's
 * icon and second line, not by its name.
 */
export function sessionName(s: Pick<SessionData, 'items' | 'view'>): string {
  const named = s.view.name?.trim()
  if (named) return named
  for (const item of s.items) {
    if (item.kind !== 'user') continue
    const line = item.text.split('\n').find((l) => l.trim())?.trim().replace(/\s+/g, ' ')
    if (line) return line.length > NAME_MAX ? `${line.slice(0, NAME_MAX - 1)}…` : line
  }
  return folderName(s.view.cwd)
}

/**
 * A session's name outside the sidebar (menu bar icon, notifications): what it was asked, like its
 * row; before anything is asked, its agent and folder, since there is no icon there to tell the agent.
 */
export function sessionLabel(s: Pick<SessionData, 'items' | 'view'>): string {
  const asked = !!s.view.name?.trim() || s.items.some((i) => i.kind === 'user' && i.text.trim())
  return asked ? sessionName(s) : `${s.view.agentName} · ${folderName(s.view.cwd)}`
}

/** What a group remembers about an open session. */
export function memberOf(s: ListedSession): GroupMember {
  const member: GroupMember = { key: s.key, title: sessionName(s.data), agentKey: effectiveAgentKey(s.data.view.agentId, s.data.view.accountId), cwd: s.data.view.cwd }
  if (s.data.view.profileId) member.profileId = s.data.view.profileId
  return member
}

/** The badge count and top state dot of a set of open sessions. */
export function summarize(sessions: readonly SessionData[]): AttentionSummary {
  return aggregateAttention(sessions.map((s) => ({ state: s.view.state, unseen: s.unseen, awaitingAnswer: awaitingAnswer(s) })))
}

/**
 * What a group's header shows, folded or not: how many of its open sessions need you (a reply to
 * read, a question, an error) and the most urgent state. Closed members count for nothing.
 */
export function groupSummary(members: readonly { session?: ListedSession }[]): AttentionSummary {
  return summarize(members.flatMap((m) => (m.session ? [m.session.data] : [])))
}

let writes: Promise<unknown> = Promise.resolve()

/**
 * Applies a change to the stored groups. Changes are applied one after the other, each on the
 * config as main has it right now (main rewrites groups by itself when a session gets its real id),
 * so neither two quick drags nor a stale copy ever overwrite a newer state.
 */
export function updateGroups(change: (state: SessionGroups) => SessionGroups, liveKeys: readonly string[]): Promise<void> {
  const run = async (): Promise<void> => {
    const stored = (await refreshConfig()).config.sessionGroups ?? EMPTY_SESSION_GROUPS
    const base = reconcileTop(stored, liveKeys)
    const next = change(base)
    if (next === base) return
    const result = await window.hub.config.saveSessionGroups(next)
    if (result.ok) await refreshConfig()
  }
  writes = writes.then(run, run)
  return writes as Promise<void>
}

/** A new group id; unique enough for one machine's config. */
export function newGroupId(): string {
  return `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
