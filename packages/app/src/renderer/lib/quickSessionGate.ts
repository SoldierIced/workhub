/**
 * Starts at most one quick session per burst of triggers. ⌘T can reach the renderer twice (the
 * native menu accelerator and the in-page key handler); both go through this gate so only the
 * first one starts a session.
 */
export function createQuickSessionGate(windowMs = 600, now: () => number = Date.now): () => boolean {
  let last = Number.NEGATIVE_INFINITY
  return () => {
    const t = now()
    if (t - last < windowMs) return false
    last = t
    return true
  }
}
