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
import type { SessionView } from '@shared/api'

export type ChatItem =
  | { id: number; kind: 'agent' | 'thought' | 'error'; text: string }
  /** `images`: data URLs of the pasted images, shown as thumbnails; a number when only the count is known (a replayed message). */
  | { id: number; kind: 'user'; text: string; images?: string[] | number }
  /** A prompt turn ended; the reason is the agent's stop reason (end_turn, cancelled...). */
  | { id: number; kind: 'turnEnd'; stopReason: string }
  /** The agent process exited; `code` is null when a signal ended it. */
  | { id: number; kind: 'exit'; code: number | null }
  /** `view`/`result`: what the call did per tool (diff, command output), when the agent reports it. */
  | { id: number; kind: 'tool'; toolCallId: string; title: string; status: string; toolKind?: string; detail?: string; view?: ToolView; result?: ToolResultView }
  | { id: number; kind: 'permission'; requestId: string; title: string; detail?: string; options: PermissionOption[]; answer?: string }
  /** A hook's output or a harness banner: its own block, never part of the agent's reply. */
  | { id: number; kind: 'notice'; noticeKind: 'hook' | 'info' | 'warning'; title: string; text: string; failed?: boolean }
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

const isOnScreen = (id: string): boolean => viewing === id && windowFocused

/** Tells the store which session is on screen (null: none, e.g. another screen is open). Viewing clears its flag. */
export function setViewing(id: string | null): void {
  viewing = id
  clearViewed()
}

function clearViewed(): void {
  const s = viewing && windowFocused ? sessions[viewing] : undefined
  if (s?.unseen) set({ ...sessions, [s.view.id]: { ...s, unseen: undefined } })
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
/** Terminal output per channel (`<session>:console`, `<session>:shell`) not yet written to an xterm. */
const terminalBuffers = new Map<string, string[]>()
const outputListeners = new Map<string, (data: string) => void>()

function set(next: Record<string, SessionData>): void {
  sessions = next
  for (const l of listeners) l()
}

function patch(id: string, fn: (s: SessionData) => SessionData): void {
  const s = sessions[id]
  if (s) set({ ...sessions, [id]: fn(s) })
}

export function pushItem(id: string, kind: 'error', text: string): void {
  patch(id, (s) => ({ ...s, items: [...s.items, { id: ++seq, kind, text }] }))
}

export function pushUser(id: string, text: string, images?: string[]): void {
  patch(id, (s) => ({ ...s, items: [...s.items, { id: ++seq, kind: 'user', text, ...(images?.length ? { images } : {}) }] }))
}

export function pushTurnEnd(id: string, stopReason: string): void {
  patch(id, (s) => withTurnEnd(s, stopReason, () => ++seq))
}

/** A turn's end divider; one only when several prompts settle together (a message folded into the running turn). */
export function withTurnEnd(s: SessionData, stopReason: string, next: () => number): SessionData {
  const last = s.items[s.items.length - 1]
  if (last?.kind === 'turnEnd' && last.stopReason === stopReason) return s
  return { ...s, items: [...s.items, { id: next(), kind: 'turnEnd', stopReason }] }
}

export function markPermission(id: string, requestId: string, answer: string): void {
  patch(id, (s) => ({
    ...s,
    items: s.items.map((i) => (i.kind === 'permission' && i.requestId === requestId ? { ...i, answer } : i))
  }))
}

/** A terminal view takes the buffered output of its channel and receives the rest live. */
export function attachOutput(channel: string, write: (data: string) => void): () => void {
  for (const chunk of terminalBuffers.get(channel) ?? []) write(chunk)
  terminalBuffers.delete(channel)
  outputListeners.set(channel, write)
  return () => {
    if (outputListeners.get(channel) === write) outputListeners.delete(channel)
  }
}

/** Chat items for the earlier messages of a resumed session. */
export function replayItems(messages: HistoryMessage[], next: () => number): ChatItem[] {
  return messages.map((m): ChatItem => {
    switch (m.kind) {
      case 'user':
        return { id: next(), kind: 'user', text: m.text, ...(m.images ? { images: m.images } : {}) }
      case 'agent':
        return { id: next(), kind: 'agent', text: m.text }
      case 'tool':
        return { id: next(), kind: 'tool', toolCallId: m.id, title: m.title, detail: m.detail, status: m.failed ? 'failed' : 'completed', view: m.view, result: m.result }
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
          : [...s.items, { id: next(), kind, text: e.text }]
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
            { id: next(), kind: 'tool' as const, toolCallId: e.toolCallId, title: e.title ?? e.toolCallId, status: e.status ?? '', toolKind: e.kind, detail: e.detail, view: e.view, result: e.result }
          ]
      return { ...s, items }
    }
    case 'permission':
      return { ...s, items: [...s.items, { id: next(), kind: 'permission', requestId: e.requestId, title: e.title, detail: e.detail, options: e.options }] }
    case 'permissionCancelled':
      return { ...s, items: s.items.map((i) => (i.kind === 'permission' && i.requestId === e.requestId && !i.answer ? { ...i, answer: '—' } : i)) }
    case 'notice':
      return { ...s, items: [...s.items, { id: next(), kind: 'notice', noticeKind: e.kind, title: e.title, text: e.text, failed: e.failed }] }
    case 'monitor':
      return { ...s, monitor: mergeMonitor(s.monitor, e.snapshot) }
    case 'exit':
      return { ...s, items: [...s.items, { id: next(), kind: 'exit', code: e.code ?? null }] }
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
    const write = outputListeners.get(e.sessionId)
    if (write) write(e.data)
    else terminalBuffers.set(e.sessionId, [...(terminalBuffers.get(e.sessionId) ?? []), e.data])
    return
  }
  const s = sessions[e.sessionId]
  if (!s) return
  const next = applyEvent(s, e, () => ++seq)
  if (next !== s) set({ ...sessions, [e.sessionId]: next })
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
