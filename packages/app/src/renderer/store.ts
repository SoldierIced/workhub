import { useSyncExternalStore } from 'react'
import { mergeMonitor, type AgentEvent, type PermissionOption, type SessionMonitorSnapshot } from '@workhub/core'
import type { SessionView } from '@shared/api'

export type ChatItem =
  | { id: number; kind: 'user' | 'agent' | 'thought' | 'error'; text: string }
  /** A prompt turn ended; the reason is the agent's stop reason (end_turn, cancelled...). */
  | { id: number; kind: 'turnEnd'; stopReason: string }
  /** The agent process exited; `code` is null when a signal ended it. */
  | { id: number; kind: 'exit'; code: number | null }
  | { id: number; kind: 'tool'; toolCallId: string; title: string; status: string; toolKind?: string }
  | { id: number; kind: 'permission'; requestId: string; title: string; options: PermissionOption[]; answer?: string }

export interface SessionData {
  view: SessionView
  items: ChatItem[]
  monitor: SessionMonitorSnapshot
  /** Terminal output not yet written to an xterm (terminal sessions). */
  output: string[]
}

let seq = 0
let sessions: Record<string, SessionData> = {}
const listeners = new Set<() => void>()
const outputListeners = new Map<string, (data: string) => void>()

function set(next: Record<string, SessionData>): void {
  sessions = next
  for (const l of listeners) l()
}

function patch(id: string, fn: (s: SessionData) => SessionData): void {
  const s = sessions[id]
  if (s) set({ ...sessions, [id]: fn(s) })
}

export function pushItem(id: string, kind: 'user' | 'error', text: string): void {
  patch(id, (s) => ({ ...s, items: [...s.items, { id: ++seq, kind, text }] }))
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

/** A terminal view takes the buffered output and receives the rest live. */
export function attachOutput(id: string, write: (data: string) => void): () => void {
  const s = sessions[id]
  if (s) {
    for (const chunk of s.output) write(chunk)
    sessions = { ...sessions, [id]: { ...s, output: [] } }
  }
  outputListeners.set(id, write)
  return () => outputListeners.delete(id)
}

function onChanged(view: SessionView): void {
  const prev = sessions[view.id]
  set({ ...sessions, [view.id]: prev ? { ...prev, view } : { view, items: [], monitor: {}, output: [] } })
}

function onEvent(e: AgentEvent): void {
  const s = sessions[e.sessionId]
  if (!s) return
  switch (e.type) {
    case 'message': {
      const kind = e.role
      const last = s.items[s.items.length - 1]
      const items =
        last && last.kind === kind
          ? [...s.items.slice(0, -1), { ...last, text: last.text + e.text }]
          : [...s.items, { id: ++seq, kind, text: e.text }]
      patch(e.sessionId, (x) => ({ ...x, items }))
      break
    }
    case 'tool': {
      const existing = s.items.find((i) => i.kind === 'tool' && i.toolCallId === e.toolCallId)
      const items = existing
        ? s.items.map((i) =>
            i.kind === 'tool' && i.toolCallId === e.toolCallId
              ? { ...i, title: e.title ?? i.title, status: e.status ?? i.status, toolKind: e.kind ?? i.toolKind }
              : i
          )
        : [...s.items, { id: ++seq, kind: 'tool' as const, toolCallId: e.toolCallId, title: e.title ?? e.toolCallId, status: e.status ?? '', toolKind: e.kind }]
      patch(e.sessionId, (x) => ({ ...x, items }))
      break
    }
    case 'permission':
      patch(e.sessionId, (x) => ({
        ...x,
        items: [...x.items, { id: ++seq, kind: 'permission', requestId: e.requestId, title: e.title, options: e.options }]
      }))
      break
    case 'monitor':
      patch(e.sessionId, (x) => ({ ...x, monitor: mergeMonitor(x.monitor, e.snapshot) }))
      break
    case 'output': {
      const write = outputListeners.get(e.sessionId)
      if (write) write(e.data)
      else sessions = { ...sessions, [e.sessionId]: { ...s, output: [...s.output, e.data] } }
      break
    }
    case 'exit':
      if (s.view.adapter !== 'terminal')
        patch(e.sessionId, (x) => ({ ...x, items: [...x.items, { id: ++seq, kind: 'exit', code: e.code ?? null }] }))
      break
    default:
      break
  }
}

let started = false
export function startStore(): void {
  if (started) return
  started = true
  window.hub.sessions.onChanged(onChanged)
  window.hub.sessions.onEvent(onEvent)
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
