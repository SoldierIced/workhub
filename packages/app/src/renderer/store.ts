import { useRef, useSyncExternalStore } from 'react'
import {
  attentionFromTransition,
  mergeMonitor,
  raiseAttention,
  type AgentEvent,
  type AgentQuestion,
  type AttentionKind,
  type HistoryMessage,
  type PermissionOption,
  type SessionMonitorSnapshot,
  type ToolResultView,
  type ToolView
} from '@workhub/core'
import { containsBell } from './lib/attention'
import { scrollbackChars, TerminalScrollback } from './lib/terminal-scrollback'
import { readPrefs } from './lib/prefs'
import type { SessionView } from '@shared/api'
import type { ChatEntry, ChatJournal } from '@shared/chat-journal'

/** `at`: epoch ms the item was sent (live) or written in the transcript (replayed); absent when unknown. */
export type ChatItem =
  | { id: number; at?: number; kind: 'agent' | 'thought' | 'error'; text: string }
  /**
   * `images`: data URLs of the pasted images, shown as thumbnails; a number when only the count is
   * known (a replayed message whose images could not be read back). `imagePaths`: each image's file
   * in the data folder once written (see main/pasted-images.ts), which the file viewer opens.
   */
  | { id: number; at?: number; kind: 'user'; text: string; images?: string[] | number; imagePaths?: (string | null)[] }
  /** A prompt turn ended; the reason is the agent's stop reason (end_turn, cancelled...). */
  | { id: number; at?: number; kind: 'turnEnd'; stopReason: string }
  /** The agent process exited; `code` is null when a signal ended it. */
  | { id: number; at?: number; kind: 'exit'; code: number | null; stderr?: string[] }
  /** `view`/`result`: what the call did per tool (diff, command output), when the agent reports it. */
  | { id: number; at?: number; kind: 'tool'; toolCallId: string; title: string; status: string; toolKind?: string; detail?: string; view?: ToolView; result?: ToolResultView }
  | { id: number; at?: number; kind: 'permission'; requestId: string; title: string; detail?: string; options: PermissionOption[]; questions?: AgentQuestion[]; answer?: string; answeredAt?: number }
  /** A hook's output or a harness banner: its own block, never part of the agent's reply. */
  | { id: number; at?: number; kind: 'notice'; noticeKind: 'hook' | 'info' | 'warning'; title: string; text: string; failed?: boolean }
  /** A compaction of the conversation: running while the agent summarizes it, then done (with what it summarized) or failed. */
  | { id: number; at?: number; kind: 'compaction'; phase: 'running' | 'done' | 'failed'; trigger?: 'auto' | 'manual'; preTokens?: number; summary?: string; error?: string }
  /** Messages of a resumed session before this run. */
  | { id: number; kind: 'replayStart'; count: number }
  /** On top of a chat rebuilt from main's journal that had to drop its oldest entries. */
  | { id: number; kind: 'truncated' }

export interface SessionData {
  view: SessionView
  items: ChatItem[]
  monitor: SessionMonitorSnapshot
  /** Why the session needs a look: set while it is off screen, cleared when it is viewed. */
  unseen?: AttentionKind
  /**
   * A permission request or question waits for an answer. The store keeps it as items change, so
   * readers (sidebar, tray, header) do not scan every item on each render.
   */
  awaiting?: boolean
  /** Id of the last turn-end item, kept as items change; absent before the first turn ends. */
  lastTurnEnd?: number
}

const scanAwaiting = (items: readonly ChatItem[]): boolean => items.some((i) => i.kind === 'permission' && i.answer === undefined)

function scanLastTurnEnd(items: readonly ChatItem[]): number | undefined {
  for (let i = items.length - 1; i >= 0; i--) if (items[i]!.kind === 'turnEnd') return items[i]!.id
  return undefined
}

/** The derived flags of a session whose items were replaced wholesale. */
function withDerived(s: SessionData): SessionData {
  return { ...s, awaiting: scanAwaiting(s.items), lastTurnEnd: scanLastTurnEnd(s.items) }
}

/** Whether a permission request or a question (in the chat, or at the console's prompt) still waits for the user's answer. */
export function awaitingAnswer(s: Pick<SessionData, 'items'> & { awaiting?: boolean; view?: Pick<SessionView, 'consoleAsking' | 'state'> }): boolean {
  return (s.awaiting ?? scanAwaiting(s.items)) || (s.view?.consoleAsking === true && (s.view.state === 'ready' || s.view.state === 'busy'))
}

/** An answer marked here that main has not confirmed after this long is reopened (the call never reached it, e.g. a phone offline). */
const ANSWER_GRACE_MS = 10_000

/** The answer shown on a request that was answered from somewhere else (the phone, another window). */
export const ANSWERED_ELSEWHERE = '✓'

/**
 * Lines the chat's permission items up with the open requests the main process keeps for the
 * session: requests the chat never saw (a window reopened, a phone that just connected, a push
 * that beat its event) are appended, and open items the main process no longer has were answered
 * elsewhere. Returns `s` itself when nothing changed.
 */
export function reconcilePending(s: SessionData, pending: SessionView['pendingPermissions'], answered: readonly string[] = [], now = Date.now()): SessionData {
  if (!pending) return s
  const open = new Set(pending.map((p) => p.requestId))
  const seen = new Set(s.items.flatMap((i) => (i.kind === 'permission' ? [i.requestId] : [])))
  let items = s.items
  // Gone from main: answered through another window or device when main says so, else withdrawn
  // (the agent cancelled it, the turn ended or was stopped). Still open in main though marked
  // answered here a while ago: the answer never arrived, so it waits again.
  const stale = (i: ChatItem) => i.kind === 'permission' && i.answer !== undefined && i.answer !== '—' && i.answer !== ANSWERED_ELSEWHERE && open.has(i.requestId) && now - (i.answeredAt ?? now) >= ANSWER_GRACE_MS
  if (s.items.some((i) => (i.kind === 'permission' && i.answer === undefined && !open.has(i.requestId)) || stale(i)))
    items = items.map((i) => {
      if (i.kind !== 'permission') return i
      if (i.answer === undefined && !open.has(i.requestId)) return { ...i, answer: answered.includes(i.requestId) ? ANSWERED_ELSEWHERE : '—' }
      if (stale(i)) return { ...i, answer: undefined, answeredAt: undefined }
      return i
    })
  const missing = pending.filter((p) => !seen.has(p.requestId))
  if (missing.length) items = [...items, ...missing.map((p) => ({ id: ++seq, at: p.at, kind: 'permission' as const, requestId: p.requestId, title: p.title, detail: p.detail, options: p.options, questions: p.questions }))]
  if (items === s.items) return s
  return { ...s, items, awaiting: scanAwaiting(items) }
}

// What the user is looking at: a session counts as seen only while its screen is up in a focused window.
let viewing: string | null = null
let windowFocused = typeof document === 'undefined' ? true : document.hasFocus()
const attentionListeners = new Set<(id: string, kind: AttentionKind) => void>()

/** The session whose own window is focused (main window only): it is on screen there. */
let externalViewing: string | null = null

const isOnScreen = (id: string): boolean => (viewing === id && windowFocused) || externalViewing === id

/** Tells the store which session is on screen (null: none, e.g. another screen is open). Viewing clears its flag. */
export function setViewing(id: string | null): void {
  viewing = id
  clearViewed()
}

function clearViewed(): void {
  for (const id of [viewing && windowFocused ? viewing : null, externalViewing]) {
    const s = id ? sessions[id] : undefined
    if (s?.unseen) set({ ...sessions, [s.view.id]: { ...s, unseen: undefined } })
  }
}

/** A session window got (or lost) the focus: its session counts as seen while it has it. */
export function setExternalViewing(id: string | null): void {
  externalViewing = id
  clearViewed()
}

/** What a session window starts from: this window's chat items, monitor and terminal output of the session. */
export function sessionSnapshot(id: string): { items: ChatItem[]; monitor: SessionMonitorSnapshot; terminals: Record<string, string> } | null {
  const s = sessions[id]
  return s ? { items: s.items, monitor: s.monitor, terminals: scrollback.ofSession(id) } : null
}

/**
 * A session window takes the main window's chat of its session. It replaces what arrived here
 * before: main holds the newer messages until this snapshot is in (see session-windows.ts).
 */
export function seedSession(id: string, snapshot: { items: unknown[]; monitor: SessionMonitorSnapshot; terminals?: Record<string, string> }): void {
  if (snapshot.terminals && typeof snapshot.terminals === 'object') seedTerminals(id, snapshot.terminals)
  const s = sessions[id]
  if (!s) return
  const items = (snapshot.items as ChatItem[]).map((i) => ({ ...i, id: ++seq }))
  set({ ...sessions, [id]: withDerived({ ...s, items, monitor: mergeMonitor(s.monitor, snapshot.monitor) }) })
}

/** Called when a session needs a look while it is off screen (an OS notification, for one). */
export function onAttention(cb: (id: string, kind: AttentionKind) => void): () => void {
  attentionListeners.add(cb)
  return () => attentionListeners.delete(cb)
}

function raise(id: string, kind: AttentionKind): void {
  const s = sessions[id]
  if (!s) return
  const onScreen = isOnScreen(id)
  const unseen = raiseAttention(s.unseen, kind, onScreen)
  if (unseen === s.unseen) return
  set({ ...sessions, [id]: { ...s, unseen } })
  // One notification until the session is looked at: more turns of the same kind (an agent that
  // goes on by itself, its background tasks) only raise it again when the kind gets stronger.
  if (!onScreen) for (const l of attentionListeners) l(id, kind)
}

/**
 * Flags a session for the user without the generic OS notification (the caller sends its own, e.g.
 * an AI review that paused for the user). Nothing is flagged while the session is on screen.
 */
export function flagAttention(id: string, kind: AttentionKind): void {
  const s = sessions[id]
  if (!s) return
  const unseen = raiseAttention(s.unseen, kind, isOnScreen(id))
  if (unseen !== s.unseen) set({ ...sessions, [id]: { ...s, unseen } })
}

let seq = 0
let sessions: Record<string, SessionData> = {}
const listeners = new Set<() => void>()
/** Terminal output per channel (`<session>:console`, `<session>:shell`), shown or not. */
const scrollback = new TerminalScrollback(() => scrollbackChars(readPrefs().terminalScrollback))
const outputListeners = new Map<string, TerminalOutput>()

/** A terminal view of a channel: `write` takes new output, `reset` clears the view before its output is replaced. */
export interface TerminalOutput {
  write: (data: string) => void
  reset?: () => void
}

function set(next: Record<string, SessionData>): void {
  sessions = next
  notify()
}

/** How often streamed agent events are shown at most (the state itself is always current). */
export const EVENT_RENDER_MS = 50
let notifyTimer: ReturnType<typeof setTimeout> | null = null

function notify(): void {
  if (notifyTimer) clearTimeout(notifyTimer)
  notifyTimer = null
  for (const l of listeners) l()
}

/**
 * Stores a streamed event's state now and renders it with the others of the next few
 * milliseconds: an agent streams many small deltas per second, and rendering the window for each
 * one kept it too busy to take a click.
 */
function setStreamed(next: Record<string, SessionData>): void {
  sessions = next
  notifyTimer ??= setTimeout(notify, EVENT_RENDER_MS)
}

function patch(id: string, fn: (s: SessionData) => SessionData): void {
  const s = sessions[id]
  if (s) set({ ...sessions, [id]: fn(s) })
}

export function pushItem(id: string, kind: 'error', text: string): void {
  patch(id, (s) => ({ ...s, items: [...s.items, { id: ++seq, at: Date.now(), kind, text }] }))
}

/** A line Workhub adds to the chat itself (what one of its own slash commands did). */
export function pushNotice(id: string, title: string, text: string): void {
  patch(id, (s) => ({ ...s, items: [...s.items, { id: ++seq, at: Date.now(), kind: 'notice', noticeKind: 'info', title, text }] }))
}

/** `journalSeq`: the prompt's number in main's chat journal; a prompt already shown under it is not shown again. */
export function pushUser(id: string, text: string, images?: string[], journalSeq?: number): void {
  const itemId = ++seq
  if (!live(id, journalSeq, (s) => ({ ...s, items: [...s.items, { id: itemId, at: Date.now(), kind: 'user', text, ...(images?.length ? { images } : {}) }] }))) return
  // Each pasted image is written once to a file of its own, so its thumbnail opens in the file viewer.
  if (images?.length) void cacheImages(images).then((paths) => paths && setImagePaths(id, itemId, paths))
}

async function cacheImages(dataUrls: string[]): Promise<(string | null)[] | null> {
  const files = typeof window === 'undefined' ? undefined : window.hub?.files
  if (!files?.cacheImages) return null
  try {
    return await files.cacheImages(dataUrls)
  } catch {
    return null
  }
}

/** Keeps the files of a message's images with it (the chat item). */
export function setImagePaths(sessionId: string, itemId: number, paths: (string | null)[]): void {
  patch(sessionId, (s) => ({
    ...s,
    items: s.items.map((i) => (i.id === itemId && i.kind === 'user' ? { ...i, imagePaths: paths } : i))
  }))
}

/**
 * Opens one of a message's images in the file viewer: its file when it was written already, else
 * it is written first (a replayed image) and the file is kept with the message.
 */
export async function openChatImage(sessionId: string, item: Extract<ChatItem, { kind: 'user' }>, index: number): Promise<void> {
  if (!Array.isArray(item.images)) return
  const src = item.images[index]
  if (!src) return
  let path = item.imagePaths?.[index] ?? null
  if (!path) {
    path = (await cacheImages([src]))?.[0] ?? null
    if (!path) return
    const current = sessions[sessionId]?.items.find((i) => i.id === item.id)
    const known = current?.kind === 'user' ? current.imagePaths : item.imagePaths
    const paths = item.images.map((_, i) => (i === index ? path : (known?.[i] ?? null)))
    setImagePaths(sessionId, item.id, paths)
  }
  await window.hub.files.openWindow(path)
}

export function pushTurnEnd(id: string, stopReason: string, journalSeq?: number): void {
  live(id, journalSeq, (s) => withTurnEnd(s, stopReason, () => ++seq))
}

/** A turn's end divider; one only when several prompts settle together (a message folded into the running turn). */
export function withTurnEnd(s: SessionData, stopReason: string, next: () => number, at = Date.now()): SessionData {
  const last = s.items[s.items.length - 1]
  if (last?.kind === 'turnEnd' && last.stopReason === stopReason) return s
  // A turn that did not end normally leaves its unfinished tool calls cancelled, not spinning forever.
  const items =
    stopReason === 'end_turn'
      ? s.items
      : s.items.map((i) =>
          i.kind === 'tool' && (i.status === 'pending' || i.status === 'in_progress') ? { ...i, status: 'cancelled' } : i.kind === 'compaction' && i.phase === 'running' ? { ...i, phase: 'failed' as const } : i
        )
  const turnEnd = next()
  return { ...s, items: [...items, { id: turnEnd, at, kind: 'turnEnd', stopReason }], lastTurnEnd: turnEnd }
}

/**
 * A compaction event on the chat: `started` adds a running divider; `done` and `failed` settle the
 * latest compaction that is running or just finished (the boundary and the summary arrive apart),
 * or add one when none is open.
 */
export function withCompaction(s: SessionData, e: Extract<AgentEvent, { type: 'compaction' }>, next: () => number, at = Date.now()): SessionData {
  const facts = { ...(e.trigger ? { trigger: e.trigger } : {}), ...(e.preTokens !== undefined ? { preTokens: e.preTokens } : {}), ...(e.summary ? { summary: e.summary } : {}), ...(e.error ? { error: e.error } : {}) }
  const last = [...s.items].reverse().find((i) => i.kind === 'compaction')
  const open = last?.kind === 'compaction' && (last.phase === 'running' || (e.phase === 'done' && last.phase === 'done' && !last.summary && s.items[s.items.length - 1] === last)) ? last : undefined
  if (e.phase === 'started') {
    if (open?.phase === 'running') return s
    return { ...s, items: [...s.items, { id: next(), at, kind: 'compaction', phase: 'running' }] }
  }
  const phase = e.phase === 'failed' ? 'failed' : 'done'
  if (open) return { ...s, items: s.items.map((i) => (i === open ? { ...open, ...facts, phase } : i)) }
  return { ...s, items: [...s.items, { id: next(), at, kind: 'compaction', phase, ...facts }] }
}

export function markPermission(id: string, requestId: string, answer: string): void {
  patch(id, (s) => {
    const items = s.items.map((i) => (i.kind === 'permission' && i.requestId === requestId ? { ...i, answer, answeredAt: Date.now() } : i))
    return { ...s, items, awaiting: scanAwaiting(items) }
  })
}

/**
 * A terminal view takes everything its channel printed so far (the scrollback, which a session
 * window gets from the main window) and receives the rest live.
 */
export function attachOutput(channel: string, view: TerminalOutput): () => void {
  const earlier = scrollback.text(channel)
  if (earlier) view.write(earlier)
  outputListeners.set(channel, view)
  return () => {
    if (outputListeners.get(channel) === view) outputListeners.delete(channel)
  }
}

/** A session's terminal output, for a session window starting from this window's view. */
export function terminalSnapshot(sessionId: string): Record<string, string> {
  return scrollback.ofSession(sessionId)
}

/** Replaces a session's terminal output with a snapshot; a view already showing it starts over from it. */
export function seedTerminals(sessionId: string, terminals: Record<string, string>): void {
  for (const [channel, data] of Object.entries(terminals)) {
    if (typeof data !== 'string' || !channel.startsWith(`${sessionId}:`)) continue
    scrollback.replace(channel, data)
    const view = outputListeners.get(channel)
    if (!view) continue
    view.reset?.()
    if (data) view.write(data)
  }
}

const at = (m: HistoryMessage): { at?: number } => (m.at === undefined ? {} : { at: m.at })

/** Chat items for the earlier messages of a resumed session. */
export function replayItems(messages: HistoryMessage[], next: () => number): ChatItem[] {
  return messages.map((m): ChatItem => {
    switch (m.kind) {
      case 'user': {
        // Images read back from the stored conversation show again; else only how many there were.
        const shown = (m.imageData ?? []).map((i) => `data:${i.mediaType};base64,${i.data}`)
        const images = shown.length ? shown : m.images
        return { id: next(), kind: 'user', text: m.text, ...(images ? { images } : {}), ...at(m) }
      }
      case 'agent':
        return { id: next(), kind: 'agent', text: m.text, ...at(m) }
      case 'notice':
        return { id: next(), kind: 'notice', noticeKind: 'info', title: m.title, text: m.text, ...at(m) }
      case 'compaction':
        return { id: next(), kind: 'compaction', phase: 'done', ...(m.summary ? { summary: m.summary } : {}), ...at(m) }
      case 'interrupted':
        return { id: next(), kind: 'turnEnd', stopReason: 'cancelled', ...at(m) }
      case 'tool':
        return { id: next(), kind: 'tool', toolCallId: m.id, title: m.title, detail: m.detail, status: m.failed ? 'failed' : 'completed', view: m.view, result: m.result, ...at(m) }
    }
  })
}

/**
 * The whole conversation of a chat that resumed (a reopened session, or the console handing it
 * back). It replaces what the chat showed: main sends it before any event of the new chat, and
 * the stored conversation already holds the earlier chat and the console's turns.
 */
export function withReplay(s: SessionData, messages: HistoryMessage[], next: () => number): SessionData {
  return withDerived({ ...s, items: [...replayItems(messages, next), { id: next(), kind: 'replayStart', count: messages.length }] })
}

/**
 * A chat opened on a paired device, which only received the live events since it connected: the
 * last page of the stored conversation replaces them, then a divider (so a reply still streaming
 * starts its own message). Open requests stay: the stored conversation does not hold them.
 */
export function withBacklog(s: SessionData, messages: HistoryMessage[], next: () => number): SessionData {
  const open = s.items.filter((i) => i.kind === 'permission' && i.answer === undefined)
  return withDerived({ ...s, items: [...replayItems(messages, next), { id: next(), kind: 'replayStart', count: messages.length }, ...open] })
}

/**
 * The stored conversation of a chat opened on a paired device is empty: what the chat showed from
 * before the question was asked (a conversation that is gone, as after a reconnect) is dropped.
 * Items numbered after `since` (a message just sent from this device, not stored yet) and open
 * requests stay.
 */
export function withoutStale(s: SessionData, since: number): SessionData {
  const items = s.items.filter((i) => i.id > since || (i.kind === 'permission' && i.answer === undefined))
  return items.length === s.items.length ? s : withDerived({ ...s, items })
}

/** An earlier page of the stored conversation, above what the chat shows (a paired device scrolling up). */
export function withEarlier(s: SessionData, messages: HistoryMessage[], next: () => number): SessionData {
  return { ...s, items: [...replayItems(messages, next), ...s.items] }
}

export function loadBacklog(id: string, messages: HistoryMessage[]): void {
  patch(id, (s) => withBacklog(s, messages, () => ++seq))
}

/** The number the next chat item gets: items numbered above it are newer than the moment it was read. */
export function itemMark(): number {
  return seq
}

export function dropStale(id: string, since: number): void {
  patch(id, (s) => withoutStale(s, since))
}

export function loadEarlier(id: string, messages: HistoryMessage[]): void {
  patch(id, (s) => withEarlier(s, messages, () => ++seq))
}

function onReplay(id: string, messages: HistoryMessage[], journalSeq?: number): void {
  live(id, journalSeq, (s) => withReplay(s, messages, () => ++seq))
}

/**
 * The chat's open permission requests and questions, marked withdrawn ("—"). Used when the chat's
 * agent process ends or hands over to the console: nothing can answer them any more, and an open
 * one would keep the session flagged as waiting for an answer.
 */
export function withdrawOpenRequests(s: SessionData): SessionData {
  if (!awaitingAnswer(s)) return s
  return { ...s, awaiting: false, items: s.items.map((i) => (i.kind === 'permission' && i.answer === undefined ? { ...i, answer: '—' } : i)) }
}

/**
 * Ids that got a push (`changed` or `removed`) while the startup `sessions.list()` was in flight:
 * the push is newer than the list, so the list's copy of those sessions is ignored. Null otherwise.
 */
let pushedDuringStartup: Set<string> | null = null

export function onChanged(view: SessionView): void {
  pushedDuringStartup?.add(view.id)
  applyView(view)
}

function applyView(view: SessionView): void {
  const prev = sessions[view.id]
  const ended = view.state === 'starting' || view.state === 'stopped' || view.state === 'error' || view.mode === 'console'
  const data = prev ? { ...prev, view } : { view, items: [], monitor: {}, awaiting: false }
  const next = ended ? withdrawOpenRequests(data) : reconcilePending(data, view.pendingPermissions, view.answeredPermissions)
  set({ ...sessions, [view.id]: next })
  const kind = attentionFromTransition(prev?.view.state, view.state)
  if (kind) raise(view.id, kind)
  // A request the chat first learns of from the view, or the console starting to ask: the session needs a look.
  const chatAsked = !ended && next.items.length > data.items.length && next.awaiting === true
  const consoleAsked = view.consoleAsking === true && prev?.view.consoleAsking !== true
  if (chatAsked || consoleAsked) raise(view.id, 'needsAnswer')
}

/** A session left the main process's list: drop it (its transcript stays in History). */
export function onRemoved(id: string): void {
  pushedDuringStartup?.add(id)
  scrollback.dropSession(id)
  applied.delete(id)
  if (!sessions[id]) return
  const { [id]: _gone, ...rest } = sessions
  set(rest)
}

/** The title of an untitled tool call. */
export const UNTITLED_TOOL = 'Used a tool'

/**
 * The title of a tool call whose start this chat never saw (the window reloaded while it ran, so
 * only its untitled result arrives): the request answered since the last tool row, which the agent
 * worded the same way (an AskUserQuestion reads "Asked you a question"), else a generic title.
 * Never the raw tool-use id.
 */
export function orphanToolTitle(items: readonly ChatItem[]): string {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!
    if (item.kind === 'tool' || item.kind === 'turnEnd' || item.kind === 'replayStart') break
    if (item.kind === 'permission' && item.answer !== undefined && item.answer !== '—') return item.title
  }
  return UNTITLED_TOOL
}

/** `at`: when the event happened (now when live, main's time when rebuilt from its journal). */
export function applyEvent(s: SessionData, e: AgentEvent, next: () => number, at = Date.now()): SessionData {
  switch (e.type) {
    case 'message': {
      const kind = e.role
      const last = s.items[s.items.length - 1]
      const items =
        last && last.kind === kind
          ? [...s.items.slice(0, -1), { ...last, text: last.text + e.text }]
          : [...s.items, { id: next(), at, kind, text: e.text }]
      return { ...s, items }
    }
    case 'tool': {
      const existing = s.items.some((i) => i.kind === 'tool' && i.toolCallId === e.toolCallId)
      const items = existing
        ? s.items.map((i) =>
            i.kind === 'tool' && i.toolCallId === e.toolCallId
              ? {
                  ...i,
                  title: e.title ?? i.title,
                  status: e.status ?? i.status,
                  toolKind: e.kind ?? i.toolKind,
                  detail: e.detail ?? i.detail,
                  view: e.view ?? i.view,
                  result: e.result ?? i.result
                }
              : i
          )
        : [
            ...s.items,
            { id: next(), at, kind: 'tool' as const, toolCallId: e.toolCallId, title: e.title ?? orphanToolTitle(s.items), status: e.status ?? '', toolKind: e.kind, detail: e.detail, view: e.view, result: e.result }
          ]
      return { ...s, items }
    }
    case 'permission':
      // The view's push may have brought the request first (see `reconcilePending`): one item per request.
      if (s.items.some((i) => i.kind === 'permission' && i.requestId === e.requestId)) return s
      return { ...s, awaiting: true, items: [...s.items, { id: next(), at, kind: 'permission', requestId: e.requestId, title: e.title, detail: e.detail, options: e.options, questions: e.questions }] }
    case 'permissionCancelled': {
      const items = s.items.map((i) => (i.kind === 'permission' && i.requestId === e.requestId && !i.answer ? { ...i, answer: '—' } : i))
      return { ...s, items, awaiting: scanAwaiting(items) }
    }
    case 'notice':
      return { ...s, items: [...s.items, { id: next(), at, kind: 'notice', noticeKind: e.kind, title: e.title, text: e.text, failed: e.failed }] }
    case 'compaction':
      return withCompaction(s, e, next, at)
    case 'monitor':
      return { ...s, monitor: mergeMonitor(s.monitor, e.snapshot) }
    case 'exit':
      return { ...s, items: [...s.items, { id: next(), at, kind: 'exit', code: e.code ?? null, ...(e.stderr?.length ? { stderr: e.stderr } : {}) }] }
    default:
      return s
  }
}

export function onEvent(e: AgentEvent, journalSeq?: number): void {
  // Terminal channels carry raw output only; their state reaches the session through `changed`.
  if (e.sessionId.includes(':')) {
    if (e.type !== 'output') return
    // A terminal agent rings the bell when it wants a look (finished, or waiting); a shell's own prompt does not count.
    if (e.sessionId.endsWith(':console') && containsBell(e.data)) raise(e.sessionId.split(':')[0]!, 'replied')
    scrollback.append(e.sessionId, e.data)
    outputListeners.get(e.sessionId)?.write(e.data)
    return
  }
  // Text deltas are batched; anything else (a tool call, a permission, the end of a turn) shows at once.
  if (live(e.sessionId, journalSeq, (s) => applyEvent(s, e, () => ++seq), e.type === 'message') && e.type === 'permission') raise(e.sessionId, 'needsAnswer')
}

/**
 * The last number of main's chat journal each session's chat holds: a message numbered at or
 * below it is in the chat already (a window rebuilt from the journal, a prompt shown by its sender).
 */
const applied = new Map<string, number>()
/** Sessions being rebuilt from main's journal, with the live changes applied meanwhile, to apply again on top. */
const hydrating = new Map<string, { seq: number; apply: (s: SessionData) => SessionData }[]>()

/**
 * Applies a live chat message to its session, once: one numbered at or below what the chat holds
 * already is skipped. False when nothing was applied (no such session, or already shown).
 */
function live(id: string, journalSeq: number | undefined, apply: (s: SessionData) => SessionData, streamed = false): boolean {
  const s = sessions[id]
  if (!s) return false
  if (typeof journalSeq === 'number') {
    if (journalSeq <= (applied.get(id) ?? 0)) return false
    applied.set(id, journalSeq)
    hydrating.get(id)?.push({ seq: journalSeq, apply })
  }
  const next = apply(s)
  if (next !== s) (streamed ? setStreamed : set)({ ...sessions, [id]: next })
  return true
}

/** One entry of main's chat journal on a chat: the same reducers as the live messages it was recorded from. */
export function applyEntry(s: SessionData, entry: ChatEntry, next: () => number, at = Date.now()): SessionData {
  switch (entry.kind) {
    case 'event':
      return applyEvent(s, entry.event, next, at)
    case 'prompt':
      return { ...s, items: [...s.items, { id: next(), at, kind: 'user', text: entry.text }] }
    case 'turnEnd':
      return withTurnEnd(s, entry.stopReason, next, at)
    case 'replay':
      return withReplay(s, entry.messages, next)
  }
}

/**
 * A session's chat rebuilt from main's journal: its entries replace the items and the monitor,
 * with a marker on top when the oldest were dropped, and the requests main still holds open.
 */
export function fromJournal(s: SessionData, journal: ChatJournal, next: () => number): SessionData {
  let out: SessionData = { ...s, items: [], monitor: journal.monitor ?? {} }
  for (const entry of journal.entries) out = applyEntry(out, entry, next, entry.at)
  // On top of a replay too, which replaces everything before it.
  if (journal.truncated) out = { ...out, items: [{ id: next(), kind: 'truncated' }, ...out.items] }
  return withDerived(out)
}

/**
 * Rebuilds a session's chat from main's journal (a window that loaded after the chat began). Live
 * messages that arrive meanwhile are applied as usual and again on top of the rebuilt chat when
 * the journal does not hold them yet; a message the journal holds is never applied twice.
 */
export function hydrateSession(id: string, journal: (id: string) => Promise<ChatJournal | null>): Promise<void> {
  if (hydrating.has(id)) return Promise.resolve()
  const meanwhile: { seq: number; apply: (s: SessionData) => SessionData }[] = []
  hydrating.set(id, meanwhile)
  const done = () => {
    if (hydrating.get(id) === meanwhile) hydrating.delete(id)
  }
  return journal(id).then(
    (j) => {
      done()
      const s = sessions[id]
      if (!j || !s) return
      let out = fromJournal(s, j, () => ++seq)
      for (const m of meanwhile) if (m.seq > j.seq) out = m.apply(out)
      out = reconcilePending(out, s.view.pendingPermissions, s.view.answeredPermissions)
      applied.set(id, Math.max(j.seq, applied.get(id) ?? 0))
      set({ ...sessions, [id]: out })
    },
    done
  )
}

/** Resolves once the store applied the sessions main had when it started. */
let storeReady: Promise<void> = Promise.resolve()

/**
 * Rebuilds the chats from main's journal, the given session's or every one the store has (desktop
 * windows only: a paired device pages the stored conversation instead).
 */
export function hydrateFromMain(id?: string): Promise<void> {
  return storeReady.then(() => Promise.all((id ? [id] : Object.keys(sessions)).map((sid) => hydrateSession(sid, (x) => window.hub.sessions.journal(x)))).then(() => undefined))
}

let started = false
export function startStore(): void {
  if (started) return
  started = true
  window.addEventListener('focus', () => {
    windowFocused = true
    clearViewed()
  })
  window.addEventListener('blur', () => {
    windowFocused = false
  })
  window.hub.sessions.onChanged(onChanged)
  window.hub.sessions.onRemoved(onRemoved)
  window.hub.sessions.onEvent(onEvent)
  window.hub.sessions.onReplay(onReplay)
  storeReady = startupList(() => window.hub.sessions.list())
}

/**
 * Applies the sessions main had when this window started, except those a push already updated or
 * removed meanwhile: a reply that arrives after a push would bring back a stale or closed session.
 */
export function startupList(list: () => Promise<SessionView[]>): Promise<void> {
  const pushed = new Set<string>()
  pushedDuringStartup = pushed
  const done = () => {
    if (pushedDuringStartup === pushed) pushedDuringStartup = null
  }
  return list().then(
    (views) => {
      done()
      for (const v of views) if (!pushed.has(v.id)) applyView(v)
    },
    done
  )
}

/** The current sessions, outside React (tests, serialized writers). */
export function getSessions(): Record<string, SessionData> {
  return sessions
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** Every session, rendered again on each change of any of them (a streamed chunk included). Prefer the narrower hooks below. */
export function useSessions(): Record<string, SessionData> {
  return useSyncExternalStore(subscribe, () => sessions)
}

/** One session: the same object until that session changes, so another session's stream leaves it alone. */
export function selectSession(all: Record<string, SessionData>, id: string | null | undefined): SessionData | undefined {
  return id ? all[id] : undefined
}

export function useSession(id: string | null | undefined): SessionData | undefined {
  return useSyncExternalStore(subscribe, () => selectSession(sessions, id))
}

/** Whether a session is open: it renders again only when that changes. */
export function useSessionOpen(id: string | null | undefined): boolean {
  return useSyncExternalStore(subscribe, () => selectSession(sessions, id) !== undefined)
}

/**
 * The value `select` reads from the sessions, kept (the previous one returned) while `same` says it
 * did not change: a component that reads only part of the sessions skips the flushes of a stream.
 */
export function selectKept<T>(prev: T | undefined, all: Record<string, SessionData>, select: (all: Record<string, SessionData>) => T, same: (a: T, b: T) => boolean): T {
  const next = select(all)
  return prev !== undefined && same(prev, next) ? prev : next
}

export function useSessionsSelector<T>(select: (all: Record<string, SessionData>) => T, same: (a: T, b: T) => boolean = Object.is): T {
  // useSyncExternalStore needs the same value back while the sessions have not changed.
  const cache = useRef<{ source: Record<string, SessionData>; select: typeof select; value: T } | null>(null)
  return useSyncExternalStore(subscribe, () => {
    const c = cache.current
    if (c && c.source === sessions && c.select === select) return c.value
    const value = selectKept(c?.value, sessions, select, same)
    cache.current = { source: sessions, select, value }
    return value
  })
}
