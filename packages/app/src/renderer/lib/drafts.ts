/**
 * Text waiting in the composer of a session that does not exist on screen yet (Investigate with
 * Claude): the draft is written for a new session and taken by its chat the first time it shows.
 * It is never sent by the app.
 */
const drafts = new Map<string, string>()
const listeners = new Set<(sessionId: string) => void>()

export function setComposerDraft(sessionId: string, text: string): void {
  drafts.set(sessionId, text)
  for (const l of listeners) l(sessionId)
}

/** Takes the draft of a session (once). */
export function takeComposerDraft(sessionId: string): string | undefined {
  const text = drafts.get(sessionId)
  drafts.delete(sessionId)
  return text
}

export function onComposerDraft(cb: (sessionId: string) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
