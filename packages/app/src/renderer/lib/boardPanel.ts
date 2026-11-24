import { useSyncExternalStore } from 'react'

/**
 * Which chats show their live board beside the chat: in memory only, per session, closed at start.
 * The chat's bar toggles it and the session pane draws it, so both read this one place.
 */
const open = new Set<string>()
const listeners = new Set<() => void>()

export const boardPanelOpen = (sessionId: string): boolean => open.has(sessionId)

export function toggleBoardPanel(sessionId: string): void {
  if (!open.delete(sessionId)) open.add(sessionId)
  for (const l of listeners) l()
}

/** Folds a chat's board away, e.g. when the chat no longer has one to show. */
export function closeBoardPanel(sessionId: string): void {
  if (open.delete(sessionId)) for (const l of listeners) l()
}

export function subscribeBoardPanel(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useBoardPanelOpen(sessionId: string): boolean {
  const read = () => open.has(sessionId)
  return useSyncExternalStore(subscribeBoardPanel, read, read)
}
