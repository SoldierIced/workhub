import { useSyncExternalStore } from 'react'
import { mergeMonitor, type AgentEvent, type HistoryMessage, type PermissionOption, type SessionMonitorSnapshot } from '@workhub/core'
import type { SessionView } from '@shared/api'

export type ChatItem =
  | { id: number; kind: 'agent' | 'thought' | 'error'; text: string }
  /** `images`: data URLs of the pasted images, shown as thumbnails; a number when only the count is known (a replayed message). */
  | { id: number; kind: 'user'; text: string; images?: string[] | number }
  /** A prompt turn ended; the reason is the agent's stop reason (end_turn, cancelled...). */
  | { id: number; kind: 'turnEnd'; stopReason: string }
  /** The agent process exited; `code` is null when a signal ended it. */
  | { id: number; kind: 'exit'; code: number | null }
  | { id: number; kind: 'tool'; toolCallId: string; title: string; status: string; toolKind?: string; detail?: string }
  | { id: number; kind: 'permission'; requestId: string; title: string; detail?: string; options: PermissionOption[]; answer?: string }
  /** A hook's output or a harness banner: its own block, never part of the agent's reply. */
  | { id: number; kind: 'notice'; noticeKind: 'hook' | 'info' | 'warning'; title: string; text: string; failed?: boolean }
  /** Messages of a resumed session before this run. */
  | { id: number; kind: 'replayStart'; count: number }

export interface SessionData {
  view: SessionView
  items: ChatItem[]
  monitor: SessionMonitorSnapshot
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
  patch(id, (s) => ({ ...s, items: [...s.items, { id: ++seq, kind: 'turnEnd', stopReason }] }))
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
        return { id: next(), kind: 'tool', toolCallId: m.id, title: m.title, detail: m.detail, status: m.failed ? 'failed' : 'completed' }
    }
  })
}

function onReplay(id: string, messages: HistoryMessage[]): void {
  patch(id, (s) => ({
    ...s,
    items: [...replayItems(messages, () => ++seq), { id: ++seq, kind: 'replayStart', count: messages.length }, ...s.items]
  }))
}

function onChanged(view: SessionView): void {
  const prev = sessions[view.id]
  set({ ...sessions, [view.id]: prev ? { ...prev, view } : { view, items: [], monitor: {} } })
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
              ? { ...i, title: e.title ?? i.title, status: e.status ?? i.status, toolKind: e.kind ?? i.toolKind, detail: e.detail ?? i.detail }
              : i
          )
        : [...s.items, { id: next(), kind: 'tool' as const, toolCallId: e.toolCallId, title: e.title ?? e.toolCallId, status: e.status ?? '', toolKind: e.kind, detail: e.detail }]
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

function onEvent(e: AgentEvent): void {
  // Terminal channels carry raw output only; their state reaches the session through `changed`.
  if (e.sessionId.includes(':')) {
    if (e.type !== 'output') return
    const write = outputListeners.get(e.sessionId)
    if (write) write(e.data)
    else terminalBuffers.set(e.sessionId, [...(terminalBuffers.get(e.sessionId) ?? []), e.data])
    return
  }
  const s = sessions[e.sessionId]
  if (!s) return
  const next = applyEvent(s, e, () => ++seq)
  if (next !== s) set({ ...sessions, [e.sessionId]: next })
}

let started = false
export function startStore(): void {
  if (started) return
  started = true
  window.hub.sessions.onChanged(onChanged)
  window.hub.sessions.onEvent(onEvent)
  window.hub.sessions.onReplay(onReplay)
  void window.hub.sessions.list().then((list) => list.forEach(onChanged))
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
