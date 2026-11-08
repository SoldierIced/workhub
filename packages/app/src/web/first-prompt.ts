// The first message typed on the New session screen: the session starts in `starting` and takes
// its first prompt once `ready`, so the chat screen sends it then (see SessionScreen).
const pending = new Map<string, string>()

export function queueFirstPrompt(sessionId: string, text: string): void {
  pending.set(sessionId, text)
}

export function takeFirstPrompt(sessionId: string): string | null {
  const text = pending.get(sessionId) ?? null
  pending.delete(sessionId)
  return text
}
