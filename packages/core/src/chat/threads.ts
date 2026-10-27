import { isReply } from './digest'
import { buildPermalink, isAfter, isMe, parsePermalink, pullRequestsIn, threadTitle, ticketsIn, tsToMs } from './links'
import { canonicalUrl } from '../codehost/urls'
import type { AutoCloseReason, ChatDigest, ChatMessage, ChatReply, ChatRun, ChatWatcherState, HookRecord, TrackedThread } from './types'

export const MESSAGE_CAP = 200
export const REPLY_CAP = 100
export const RUN_LOG_CAP = 30
const SENT_CAP = 50
const WAKE_LOG_CAP = 10

/** Something the user should hear about; the app words it in the UI language. */
export type ChatNotice =
  /** Someone wrote about one of my pull requests in a watched channel. */
  | { kind: 'myPullRequest'; channelId: string; user: string; text: string; prUrl: string; permalink?: string }
  /** New replies in a followed thread (at most three are listed; `more` counts the rest). */
  | { kind: 'replies'; threadId: string; title: string; replies: ChatReply[]; more: number; permalink: string; prUrl?: string }
  /** A thread started being followed because a session sent a message to it. */
  | { kind: 'tracking'; threadId: string; title: string; channelId: string }

export function isListening(t: Pick<TrackedThread, 'closed' | 'wake' | 'owner'>): boolean {
  return !t.closed && t.wake && Boolean(t.owner)
}

/** A new thread with the defaults every source shares. */
export function newThread(fields: Pick<TrackedThread, 'id' | 'channelId' | 'ts' | 'permalink' | 'title' | 'source' | 'createdAt'> & Partial<TrackedThread>): TrackedThread {
  return { wake: false, lastSeenReplyTs: fields.ts, closed: false, seeded: false, replies: [], sentTs: [], pendingWake: [], wakeLog: [], ...fields }
}

/** The workspace host of any permalink seen so far, to build links for messages that came without one. */
export function knownHost(state: ChatWatcherState): string | null {
  const links = [...state.threads.map((t) => t.permalink), ...Object.values(state.messages).flatMap((list) => list.map((m) => m.permalink ?? ''))]
  for (const l of links) {
    const p = parsePermalink(l)
    if (p) return p.host
  }
  return null
}

export function permalinkFor(state: ChatWatcherState, channelId: string, ts: string, threadTs?: string): string {
  const host = knownHost(state)
  return host ? buildPermalink(host, channelId, ts, threadTs) : `https://slack.com/app_redirect?channel=${channelId}`
}

// Applying a read

export interface ApplyContext {
  /** Ids of the channels being watched; messages of other channels are ignored. */
  channelIds: readonly string[]
  /** Canonical URLs of the user's own open pull requests, for the "my PR" notice. */
  myPullRequests?: ReadonlySet<string>
}

export interface ApplyResult {
  state: ChatWatcherState
  /** New top-level and reply messages of watched channels; empty on the seeding read. */
  fresh: ChatMessage[]
  messages: number
  replies: number
  notices: ChatNotice[]
}

/**
 * Stores what a read brought: new channel messages after each cursor, new replies of followed
 * threads (queued for their owner when the thread wakes it). The first read only learns what is
 * already there: it notifies and triggers nothing.
 */
export function applyDigest(state: ChatWatcherState, digest: ChatDigest, ctx: ApplyContext): ApplyResult {
  const notify = state.seeded
  const known = new Set(ctx.channelIds)
  const me = digest.me || state.me
  const messages = { ...state.messages }
  const cursors = { ...state.cursors }
  const fresh: ChatMessage[] = []
  const notices: ChatNotice[] = []
  let newMessages = 0

  for (const channel of digest.channels) {
    if (!known.has(channel.id)) continue
    const cursor = cursors[channel.id]
    const stored = messages[channel.id] ?? []
    const seen = new Set(stored.map((m) => m.ts))
    const added: ChatMessage[] = []
    for (const m of channel.messages) {
      if (cursor && !isAfter(m.ts, cursor)) continue
      if (seen.has(m.ts)) continue
      seen.add(m.ts)
      added.push({ ...m, channelId: channel.id })
    }
    // A channel the agent could not read keeps its cursor, so nothing is skipped next time.
    if (!added.length) continue
    newMessages += added.length
    fresh.push(...added)
    const all = [...stored, ...added].sort((a, b) => tsToMs(b.ts) - tsToMs(a.ts))
    messages[channel.id] = all.slice(0, MESSAGE_CAP)
    cursors[channel.id] = added.reduce((max, m) => (isAfter(m.ts, max) ? m.ts : max), added[0]!.ts)
    if (notify && ctx.myPullRequests?.size) {
      for (const m of added) {
        if (isMe(m.user, me)) continue
        const root = isReply(m) ? all.find((x) => x.ts === m.threadTs) : undefined
        const pr = [...m.prUrls, ...(root?.prUrls ?? [])].find((u) => ctx.myPullRequests!.has(canonicalUrl(u)))
        if (pr) notices.push({ kind: 'myPullRequest', channelId: channel.id, user: m.user, text: m.text, prUrl: pr, ...(m.permalink ? { permalink: m.permalink } : {}) })
      }
    }
  }

  let newReplies = 0
  const threads = state.threads.map((thread) => {
    const result = digest.threads.find((r) => r.channelId === thread.channelId && r.ts === thread.ts)
    if (!result) return thread
    const own = new Set(thread.sentTs)
    const have = new Set(thread.replies.map((r) => r.ts))
    const added = result.replies
      .filter((r) => r.ts !== thread.ts && isAfter(r.ts, thread.lastSeenReplyTs) && !own.has(r.ts) && !have.has(r.ts))
      .filter((r, i, all) => all.findIndex((x) => x.ts === r.ts) === i)
      .sort((a, b) => tsToMs(a.ts) - tsToMs(b.ts))
    const firstRead = !thread.seeded
    if (!added.length) return thread.seeded ? thread : { ...thread, seeded: true }
    newReplies += added.length
    const next: TrackedThread = {
      ...thread,
      seeded: true,
      replies: [...thread.replies, ...added].slice(-REPLY_CAP),
      lastSeenReplyTs: added[added.length - 1]!.ts
    }
    if (!notify || firstRead) return next
    const others = added.filter((r) => !isMe(r.user, me))
    if (!others.length) return next
    notices.push({ kind: 'replies', threadId: thread.id, title: thread.title, replies: others.slice(0, 3), more: Math.max(0, others.length - 3), permalink: thread.permalink, ...(thread.prUrl ? { prUrl: thread.prUrl } : {}) })
    return isListening(next) ? { ...next, pendingWake: [...next.pendingWake, ...others] } : next
  })

  return {
    state: { ...state, messages, cursors, threads, seeded: true, me },
    fresh: notify ? fresh : [],
    messages: newMessages,
    replies: newReplies,
    notices
  }
}

export function logRun(state: ChatWatcherState, run: ChatRun): ChatWatcherState {
  return { ...state, runs: [run, ...state.runs].slice(0, RUN_LOG_CAP) }
}

// Threads sessions start (the tracking hook)

export interface IngestContext {
  now: number
  newId: () => string
  /** An automation set not to receive chat replies: its threads are neither tracked nor linked to it. */
  ignored?: (identity: string) => boolean
  /** The agent key of the account behind a config folder, to reopen its sessions. */
  agentKeyFor?: (configDir: string | undefined) => string | undefined
}

/**
 * Follows the thread of a message a session sent, owned by that session and waking it on replies.
 * A thread already followed reopens and keeps its owner: another session writing in it (a review
 * automation answering the request a chat posted) never takes it over.
 */
export function ingestRecord(state: ChatWatcherState, record: HookRecord, ctx: IngestContext): { state: ChatWatcherState; notice?: ChatNotice } {
  const root = record.threadTs ?? record.ts
  if (!root || !record.channelId || !record.sessionId) return { state }
  const identity = record.sessionId.toLowerCase()
  const sentTs = record.ts ?? (ctx.now / 1000).toFixed(6)
  const text = record.text ?? record.title ?? ''
  const ignored = ctx.ignored?.(identity) ?? false
  const index = state.threads.findIndex((t) => t.channelId === record.channelId && t.ts === root)
  if (index >= 0) {
    const thread = state.threads[index]!
    // The message is the session's own either way, so it never counts as a reply.
    let next: TrackedThread = {
      ...thread,
      sentTs: [...thread.sentTs, sentTs].slice(-SENT_CAP),
      lastSeenReplyTs: isAfter(sentTs, thread.lastSeenReplyTs) ? sentTs : thread.lastSeenReplyTs
    }
    if (!ignored) {
      if (!next.owner) {
        const agentKey = ctx.agentKeyFor?.(record.configDir)
        next = { ...next, owner: identity, wake: true, ...(agentKey ? { ownerAgentKey: agentKey } : {}), ...(record.configDir ? { configDir: record.configDir } : {}), ...(record.cwd ? { sentFromCwd: record.cwd } : {}) }
      }
      if (next.closed) next = { ...next, closed: false, closedReason: undefined, reopenedAt: ctx.now }
      if (!next.prUrl) {
        const pr = pullRequestsIn(text)[0]
        if (pr) next = { ...next, prUrl: pr }
      }
      if (!next.ticketKey) {
        const key = ticketsIn(text)[0]
        if (key) next = { ...next, ticketKey: key }
      }
    }
    const threads = [...state.threads]
    threads[index] = next
    return { state: { ...state, threads } }
  }
  if (ignored) return { state }
  const firstLine = (record.text ?? '').split(/\r?\n/).find((l) => l.trim())
  const title = (firstLine ? threadTitle(firstLine) : '') || record.title?.trim() || `Thread ${root.slice(0, 10)}`
  const agentKey = ctx.agentKeyFor?.(record.configDir)
  const thread = newThread({
    id: ctx.newId(),
    channelId: record.channelId,
    ts: root,
    permalink: record.permalink ?? permalinkFor(state, record.channelId, sentTs, root),
    title,
    source: 'hook',
    createdAt: ctx.now,
    owner: identity,
    ...(agentKey ? { ownerAgentKey: agentKey } : {}),
    wake: true,
    // The baseline is the message the session sent, so the first read may already wake it.
    seeded: true,
    lastSeenReplyTs: sentTs,
    sentTs: [sentTs],
    ...(pullRequestsIn(text)[0] ? { prUrl: pullRequestsIn(text)[0] } : {}),
    ...(ticketsIn(text)[0] ? { ticketKey: ticketsIn(text)[0] } : {}),
    ...(record.configDir ? { configDir: record.configDir } : {}),
    ...(record.cwd ? { sentFromCwd: record.cwd } : {})
  })
  return { state: { ...state, threads: [thread, ...state.threads] }, notice: { kind: 'tracking', threadId: thread.id, title, channelId: record.channelId } }
}

// Tracking by hand

export interface TrackInput {
  permalink: string
  title?: string
  prUrl?: string
  ticketKey?: string
  owner?: string
  ownerAgentKey?: string
  wake?: boolean
}

export type TrackError = 'notAPermalink' | 'alreadyTracked'

/** Follows the thread a pasted permalink points to. */
export function trackPermalink(state: ChatWatcherState, input: TrackInput, now: number, newId: () => string): { state: ChatWatcherState; error?: TrackError; thread?: TrackedThread } {
  const link = parsePermalink(input.permalink)
  if (!link) return { state, error: 'notAPermalink' }
  if (state.threads.some((t) => t.channelId === link.channelId && t.ts === link.rootTs && !t.closed)) return { state, error: 'alreadyTracked' }
  const pr = input.prUrl?.trim() ? (pullRequestsIn(input.prUrl)[0] ?? input.prUrl.trim()) : undefined
  const wake = Boolean(input.wake && input.owner)
  const thread = newThread({
    id: newId(),
    channelId: link.channelId,
    ts: link.rootTs,
    permalink: input.permalink.trim(),
    title: input.title?.trim() || `Thread ${link.rootTs.slice(0, 10)}`,
    source: 'manual',
    createdAt: now,
    ...(pr ? { prUrl: pr } : {}),
    ...(input.ticketKey?.trim() ? { ticketKey: input.ticketKey.trim().toUpperCase() } : {}),
    ...(input.owner ? { owner: input.owner } : {}),
    ...(input.ownerAgentKey ? { ownerAgentKey: input.ownerAgentKey } : {}),
    wake,
    // Followed for a session, the replies already there are what it should read: they count as new.
    seeded: wake
  })
  return { state: { ...state, threads: [thread, ...state.threads] }, thread }
}

/** Follows the thread of a channel message, its links taken from the text. */
export function trackMessage(state: ChatWatcherState, message: ChatMessage, now: number, newId: () => string): ChatWatcherState {
  const root = message.threadTs ?? message.ts
  if (state.threads.some((t) => t.channelId === message.channelId && t.ts === root && !t.closed)) return state
  const firstLine = message.text.split(/\r?\n/).find((l) => l.trim()) ?? message.text
  const thread = newThread({
    id: newId(),
    channelId: message.channelId,
    ts: root,
    permalink: message.permalink ?? permalinkFor(state, message.channelId, message.ts, message.threadTs),
    title: threadTitle(firstLine) || `Thread ${root.slice(0, 10)}`,
    source: 'manual',
    createdAt: now,
    ...(message.prUrls[0] ? { prUrl: message.prUrls[0] } : {}),
    ...(message.tickets[0] ? { ticketKey: message.tickets[0] } : {})
  })
  return { ...state, threads: [thread, ...state.threads] }
}

export function updateThread(state: ChatWatcherState, id: string, change: (t: TrackedThread) => TrackedThread): ChatWatcherState {
  return { ...state, threads: state.threads.map((t) => (t.id === id ? change(t) : t)) }
}

export function closeThread(t: TrackedThread, reason?: AutoCloseReason): TrackedThread {
  return { ...t, closed: true, ...(reason ? { closedReason: reason } : { closedReason: undefined }) }
}

/** Opens a closed thread again; an open one is left as it is. */
export function reopenThread(t: TrackedThread, now: number): TrackedThread {
  return t.closed ? { ...t, closed: false, closedReason: undefined, reopenedAt: now } : t
}

/** Hands every reply of the thread (except the user's own) to its owner now. */
export function sendRepliesToOwner(t: TrackedThread, me: string, now: number): TrackedThread {
  if (!t.owner) return t
  const replies = t.replies.filter((r) => !isMe(r.user, me))
  if (!replies.length) return t
  return { ...reopenThread(t, now), wake: true, pendingWake: replies }
}

/** Notes a wake attempt; a pending note repeating the last one is not logged again. */
export function recordWake(t: TrackedThread, outcome: TrackedThread['wakeLog'][number]['outcome'], detail: string, now: number, clearPending: boolean): TrackedThread {
  const base = clearPending ? { ...t, pendingWake: [], lastWakeAt: now } : t
  const last = base.wakeLog[0]
  if (last && outcome === 'pending' && last.outcome === outcome && last.detail === detail) return base
  return { ...base, wakeLog: [{ at: now, outcome, detail }, ...base.wakeLog].slice(0, WAKE_LOG_CAP) }
}

export function hasUnread(t: TrackedThread, me: string): boolean {
  const baseline = t.lastViewedReplyTs ?? t.ts
  return t.replies.some((r) => isAfter(r.ts, baseline) && !isMe(r.user, me))
}

// Ownership

/** The open threads whose replies are typed into the session with this identity. */
export function listeningThreadsOf(threads: readonly TrackedThread[], identity: string): TrackedThread[] {
  return threads.filter((t) => isListening(t) && t.owner === identity)
}

/**
 * Moves every open thread owned by `from` to `to` (an automation that starts a new session per
 * run hands its threads to the new session), with the replies still waiting for delivery. Closed
 * threads keep their owner for the history.
 */
export function transferThreads(threads: readonly TrackedThread[], from: string, to: string, agentKey?: string): { threads: TrackedThread[]; moved: number } {
  if (from === to) return { threads: [...threads], moved: 0 }
  let moved = 0
  const next = threads.map((t) => {
    if (t.closed || t.owner !== from) return t
    moved += 1
    return { ...t, owner: to, ...(agentKey ? { ownerAgentKey: agentKey } : {}) }
  })
  return { threads: next, moved }
}

// Closing on their own

export const IDLE_LIMIT_MS = 7 * 86_400_000
export const PR_CHECK_INTERVAL_MS = 3_600_000

export function lastActivity(t: TrackedThread): number {
  return Math.max(t.createdAt, t.reopenedAt ?? 0, tsToMs(t.lastSeenReplyTs), ...t.replies.map((r) => tsToMs(r.ts)))
}

/**
 * Why an open thread should close now, or null to keep following it. `prState` is the state of
 * its PR (`open`, `merged`, `closed`) when it is known; an unknown state never closes it.
 */
export function autoCloseReason(t: TrackedThread, prState: string | undefined, now: number): AutoCloseReason | null {
  if (t.closed) return null
  // A thread reopened by the user (or its session) stays open while its PR is done, and a reply
  // still waiting for the session is delivered first.
  if (t.prUrl && t.reopenedAt === undefined && t.pendingWake.length === 0) {
    if (prState === 'merged') return 'prMerged'
    if (prState === 'closed') return 'prClosed'
  }
  return now - lastActivity(t) >= IDLE_LIMIT_MS ? 'idle' : null
}

/** Closes the threads that are done, keeping them in the history with the reason. */
export function closeFinished(state: ChatWatcherState, prStates: ReadonlyMap<string, string>, now: number): ChatWatcherState {
  let changed = false
  const threads = state.threads.map((t) => {
    const reason = autoCloseReason(t, t.prUrl ? prStates.get(canonicalUrl(t.prUrl)) : undefined, now)
    if (!reason) return t
    changed = true
    return closeThread(t, reason)
  })
  return changed ? { ...state, threads } : state
}

/** A row of the followed-threads list: a thread on its own, or the threads that share a PR. */
export type ThreadRow = { kind: 'single'; thread: TrackedThread } | { kind: 'pullRequest'; url: string; threads: TrackedThread[] }

/** Threads that share a PR become one row, where the first of them was. */
export function threadRows(threads: readonly TrackedThread[]): ThreadRow[] {
  const byPr = new Map<string, TrackedThread[]>()
  for (const t of threads) if (t.prUrl) byPr.set(canonicalUrl(t.prUrl), [...(byPr.get(canonicalUrl(t.prUrl)) ?? []), t])
  const rows: ThreadRow[] = []
  const placed = new Set<string>()
  for (const t of threads) {
    const key = t.prUrl ? canonicalUrl(t.prUrl) : null
    const members = key ? (byPr.get(key) ?? [t]) : [t]
    if (!key || members.length < 2) rows.push({ kind: 'single', thread: t })
    else if (!placed.has(key)) {
      placed.add(key)
      rows.push({ kind: 'pullRequest', url: t.prUrl!, threads: members })
    }
  }
  return rows
}

/** Messages and threads that mention a PR, for its Slack badge. */
export function linksForPullRequest(state: ChatWatcherState, url: string): { messages: ChatMessage[]; threads: TrackedThread[] } {
  return pullRequestSlackLinks(Object.values(state.messages).flat(), state.threads, url)
}

/** The channel messages that link a PR and the threads about it (tracked for it, or a reply links it). */
export function pullRequestSlackLinks(messages: readonly ChatMessage[], threads: readonly TrackedThread[], url: string): { messages: ChatMessage[]; threads: TrackedThread[] } {
  const key = canonicalUrl(url)
  return {
    messages: messages.filter((m) => m.prUrls.some((u) => canonicalUrl(u) === key)),
    threads: threads.filter((t) => (t.prUrl && canonicalUrl(t.prUrl) === key) || t.replies.some((r) => pullRequestsIn(r.text).some((u) => canonicalUrl(u) === key)))
  }
}

/** What a Slack badge shows: how many threads and messages, and whether a thread has unread replies. */
export interface SlackLinkSummary {
  threads: number
  messages: number
  unread: boolean
}

/** The badge of a set of links; null when there is nothing in Slack, so no badge shows. */
export function slackLinkSummary(links: { messages: readonly ChatMessage[]; threads: readonly TrackedThread[] }, me: string): SlackLinkSummary | null {
  if (links.messages.length === 0 && links.threads.length === 0) return null
  return { threads: links.threads.length, messages: links.messages.length, unread: links.threads.some((t) => !t.closed && hasUnread(t, me)) }
}

/** The open threads a session owns (by its stable identity), for the session row's badge. */
export function threadsOfSession(threads: readonly TrackedThread[], identity: string): TrackedThread[] {
  return threads.filter((t) => t.owner === identity && !t.closed)
}
