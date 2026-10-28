import { useSyncExternalStore } from 'react'
import {
  attentionFromTransition,
  mergeMonitor,
  raiseAttention,
  type AgentEvent,
  type AttentionKind,
  type HistoryMessage,
  type PermissionOption,
  type SessionMonitorSnapshot,
  type ToolResultView,
  type ToolView
} from '@workhub/core'
import { containsBell } from './lib/attention'
import { TerminalScrollback } from './lib/terminal-scrollback'
import type { SessionView } from '@shared/api'

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
  | { id: number; at?: number; kind: 'exit'; code: number | null }
  /** `view`/`result`: what the call did per tool (diff, command output), when the agent reports it. */
  | { id: number; at?: number; kind: 'tool'; toolCallId: string; title: string; status: string; toolKind?: string; detail?: string; view?: ToolView; result?: ToolResultView }
  | { id: number; at?: number; kind: 'permission'; requestId: string; title: string; detail?: string; options: PermissionOption[]; answer?: string }
  /** A hook's output or a harness banner: its own block, never part of the agent's reply. */
  | { id: number; at?: number; kind: 'notice'; noticeKind: 'hook' | 'info' | 'warning'; title: string; text: string; failed?: boolean }
  /** Messages of a resumed session before this run. */
  | { id: number; kind: 'replayStart'; count: number }

export interface SessionData {
  view: SessionView
  items: ChatItem[]
  monitor: SessionMonitorSnapshot
  /** Why the session needs a look: set while it is off screen, cleared when it is viewed. */
  unseen?: AttentionKind
}

/** Whether a permission request or a question is still waiting for the user's answer. */
export function awaitingAnswer(s: Pick<SessionData, 'items'>): boolean {
  return s.items.some((i) => i.kind === 'permission' && i.answer === undefined)
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
  set({ ...sessions, [id]: { ...s, items, monitor: mergeMonitor(s.monitor, snapshot.monitor) } })
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
  if (unseen !== s.unseen) set({ ...sessions, [id]: { ...s, unseen } })
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
const scrollback = new TerminalScrollback()
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

export function pushUser(id: string, text: string, images?: string[]): void {
  const itemId = ++seq
  patch(id, (s) => ({ ...s, items: [...s.items, { id: itemId, at: Date.now(), kind: 'user', text, ...(images?.length ? { images } : {}) }] }))
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

export function pushTurnEnd(id: string, stopReason: string): void {
  patch(id, (s) => withTurnEnd(s, stopReason, () => ++seq))
}

/** A turn's end divider; one only when several prompts settle together (a message folded into the running turn). */
export function withTurnEnd(s: SessionData, stopReason: string, next: () => number): SessionData {
  const last = s.items[s.items.length - 1]
  if (last?.kind === 'turnEnd' && last.stopReason === stopReason) return s
  // A turn that did not end normally leaves its unfinished tool calls cancelled, not spinning forever.
  const items =
    stopReason === 'end_turn'
      ? s.items
      : s.items.map((i) => (i.kind === 'tool' && (i.status === 'pending' || i.status === 'in_progress') ? { ...i, status: 'cancelled' } : i))
  return { ...s, items: [...items, { id: next(), at: Date.now(), kind: 'turnEnd', stopReason }] }
}

export function markPermission(id: string, requestId: string, answer: string): void {
  patch(id, (s) => ({
    ...s,
    items: s.items.map((i) => (i.kind === 'permission' && i.requestId === requestId ? { ...i, answer } : i))
  }))
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
  return { ...s, items: [...replayItems(messages, next), { id: next(), kind: 'replayStart', count: messages.length }] }
}

function onReplay(id: string, messages: HistoryMessage[]): void {
  patch(id, (s) => withReplay(s, messages, () => ++seq))
}

export function onChanged(view: SessionView): void {
  const prev = sessions[view.id]
  set({ ...sessions, [view.id]: prev ? { ...prev, view } : { view, items: [], monitor: {} } })
  const kind = attentionFromTransition(prev?.view.state, view.state)
  if (kind) raise(view.id, kind)
}

/** A session left the main process's list: drop it (its transcript stays in History). */
export function onRemoved(id: string): void {
  scrollback.dropSession(id)
  if (!sessions[id]) return
  const { [id]: _gone, ...rest } = sessions
  set(rest)
}

export function applyEvent(s: SessionData, e: AgentEvent, next: () => number): SessionData {
  switch (e.type) {
    case 'message': {
      const kind = e.role
      const last = s.items[s.items.length - 1]
      const items =
        last && last.kind === kind
          ? [...s.items.slice(0, -1), { ...last, text: last.text + e.text }]
          : [...s.items, { id: next(), at: Date.now(), kind, text: e.text }]
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
            { id: next(), at: Date.now(), kind: 'tool' as const, toolCallId: e.toolCallId, title: e.title ?? e.toolCallId, status: e.status ?? '', toolKind: e.kind, detail: e.detail, view: e.view, result: e.result }
          ]
      return { ...s, items }
    }
    case 'permission':
      return { ...s, items: [...s.items, { id: next(), at: Date.now(), kind: 'permission', requestId: e.requestId, title: e.title, detail: e.detail, options: e.options }] }
    case 'permissionCancelled':
      return { ...s, items: s.items.map((i) => (i.kind === 'permission' && i.requestId === e.requestId && !i.answer ? { ...i, answer: '—' } : i)) }
    case 'notice':
      return { ...s, items: [...s.items, { id: next(), at: Date.now(), kind: 'notice', noticeKind: e.kind, title: e.title, text: e.text, failed: e.failed }] }
    case 'monitor':
      return { ...s, monitor: mergeMonitor(s.monitor, e.snapshot) }
    case 'exit':
      return { ...s, items: [...s.items, { id: next(), at: Date.now(), kind: 'exit', code: e.code ?? null }] }
    default:
      return s
  }
}

export function onEvent(e: AgentEvent): void {
  // Terminal channels carry raw output only; their state reaches the session through `changed`.
  if (e.sessionId.includes(':')) {
    if (e.type !== 'output') return
    // A terminal agent rings the bell when it wants a look (finished, or waiting); a shell's own prompt does not count.
    if (e.sessionId.endsWith(':console') && containsBell(e.data)) raise(e.sessionId.split(':')[0]!, 'replied')
    scrollback.append(e.sessionId, e.data)
    outputListeners.get(e.sessionId)?.write(e.data)
    return
  }
  const s = sessions[e.sessionId]
  if (!s) return
  const next = applyEvent(s, e, () => ++seq)
  // Text deltas are batched; anything else (a tool call, a permission, the end of a turn) shows at once.
  if (next !== s) (e.type === 'message' ? setStreamed : set)({ ...sessions, [e.sessionId]: next })
  if (e.type === 'permission') raise(e.sessionId, 'needsAnswer')
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
  void window.hub.sessions.list().then((list) => list.forEach(onChanged))
}

/** The current sessions, outside React (tests, serialized writers). */
export function getSessions(): Record<string, SessionData> {
  return sessions
}

export function useSessions(): Record<string, SessionData> {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => sessions
  )
}
