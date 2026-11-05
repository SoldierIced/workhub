// The hash route of a "Review with another agent" loop window, built by main and read by the renderer.

export function reviewLoopWindowHash(loopId: string): string {
  return `#review-loop?id=${encodeURIComponent(loopId)}`
}

export function parseReviewLoopHash(hash: string): { loopId: string } | null {
  const m = /^#review-loop\?(.*)$/.exec(hash)
  if (!m) return null
  const id = new URLSearchParams(m[1]).get('id')
  return id ? { loopId: id } : null
}
