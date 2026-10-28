import {
  aggregateAttention,
  applyHistory,
  EMPTY_SESSION_GROUPS,
  effectiveAgentKey,
  needsHistoryLookup,
  reconcileTop,
  resolveSessionName,
  sessionIdentity,
  type AttentionSummary,
  type GroupMember,
  type PastSessionInfo,
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

/** A bare slash command (`/clear`, `/compact`) says nothing about what the session is for. */
const BARE_COMMAND = /^\/\S+$/

/**
 * What the sidebar calls an open session, and whether that is a name of its own: the name the user
 * gave it (Rename…, `/rename`), else the title its agent gave it, else the first line of what the
 * user first asked, else its folder. The agent and the account are shown by the row's icon and
 * second line, not by its name.
 */
export function sessionNameInfo(s: Pick<SessionData, 'items' | 'view'>): { title: string; titled: boolean } {
  const firstPrompt = s.items.find((item) => item.kind === 'user' && item.text.trim() && !BARE_COMMAND.test(item.text.trim()))
  return resolveSessionName({ name: s.view.name, title: s.view.agentTitle, firstPrompt: firstPrompt?.kind === 'user' ? firstPrompt.text : undefined, cwd: s.view.cwd })
}

export function sessionName(s: Pick<SessionData, 'items' | 'view'>): string {
  return sessionNameInfo(s).title
}

/**
 * A sidebar row's name: the open session's own name, else what its group member remembers (a name
 * from before it was reopened, or the agent's title from the history), else the history's title
 * for an open session outside any group, else the folder.
 */
export function rowName(entry: ListedSession | undefined, member: GroupMember, pastTitle?: string): string {
  if (entry) {
    const live = sessionNameInfo(entry.data)
    if (live.titled) return live.title
  }
  if (member.titled) return member.title
  if (pastTitle) return resolveSessionName({ title: pastTitle, cwd: member.cwd }).title
  return entry ? sessionName(entry.data) : member.title
}

/**
 * A session's name outside the sidebar (menu bar icon, notifications): what it was asked, like its
 * row; before anything is asked, its agent and folder, since there is no icon there to tell the agent.
 */
export function sessionLabel(s: Pick<SessionData, 'items' | 'view'>): string {
  const asked = !!s.view.name?.trim() || !!s.view.agentTitle || s.items.some((i) => i.kind === 'user' && i.text.trim())
  return asked ? sessionName(s) : `${s.view.agentName} · ${folderName(s.view.cwd)}`
}

/** What a group remembers about an open session, to list it with its name, agent and account once closed. */
export function memberOf(s: ListedSession): GroupMember {
  const { view } = s.data
  const name = sessionNameInfo(s.data)
  const member: GroupMember = { key: s.key, title: name.title, agentKey: effectiveAgentKey(view.agentId, view.accountId), cwd: view.cwd, agentId: view.agentId }
  if (name.titled) member.titled = true
  if (view.agentName) member.agentName = view.agentName
  if (view.accountId) member.accountId = view.accountId
  if (view.accountName) member.accountName = view.accountName
  if (view.profileId) member.profileId = view.profileId
  return member
}

/**
 * The identities to look up in the session history: group members that lack their name or account
 * (saved by an older Workhub, or closed before anything was asked), and open sessions known only by
 * their folder. `asked` holds the ones already looked up in this run, so each is read once.
 */
export function historyLookupKeys(groups: SessionGroups, listed: readonly ListedSession[], asked: ReadonlySet<string>): string[] {
  // A session started here (not reopened) has no past to look up: it names itself when asked something.
  const reopened = (l: ListedSession) => !!l.data.view.resumed && !!l.data.view.agentSessionId
  const live = new Map(listed.map((l) => [l.key, l]))
  const keys = new Set<string>()
  for (const g of groups.groups) {
    for (const m of g.members) {
      const open = live.get(m.key)
      if (needsHistoryLookup(m) && !asked.has(m.key) && (!open || reopened(open))) keys.add(m.key)
    }
  }
  for (const l of listed) if (reopened(l) && !asked.has(l.key) && !sessionNameInfo(l.data).titled) keys.add(l.key)
  return [...keys]
}

/** The newest history title of each identity found, for open sessions outside any group. */
export function pastTitles(entries: readonly PastSessionInfo[]): Map<string, string> {
  const newest = new Map<string, PastSessionInfo>()
  for (const e of entries) {
    const prev = newest.get(e.agentSessionId)
    if (!prev || e.lastModified > prev.lastModified) newest.set(e.agentSessionId, e)
  }
  return new Map([...newest].flatMap(([key, e]) => (e.title.trim() ? [[key, e.title] as const] : [])))
}

/**
 * Looks members and open sessions up in the history once: members keep what is found (and that
 * they were looked up) in the stored groups; the titles found are returned for the open rows.
 */
export async function lookUpHistory(keys: readonly string[], liveKeys: readonly string[]): Promise<Map<string, string>> {
  if (!keys.length) return new Map()
  const entries = await window.hub.history.find([...keys])
  const searched = new Set(keys)
  await updateGroups((g) => applyHistory(g, entries, searched), liveKeys)
  return pastTitles(entries)
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
    // Read without publishing: every published snapshot renders the whole window again, and the
    // saved one is published below anyway.
    const stored = (await window.hub.config.get()).config.sessionGroups ?? EMPTY_SESSION_GROUPS
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
