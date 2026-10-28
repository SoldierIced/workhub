import { useEffect, useSyncExternalStore } from 'react'
import { sessionIdentity } from '@workhub/core'
import type { SessionView } from '@shared/api'
import type { AiReviewHold, AiReviewSnapshot, AiReviewView, ReviewLoopView } from '@shared/ai-review-api'

/** The AI reviews pushed by the main process. */
let value: AiReviewSnapshot | null = null
let started = false
const listeners = new Set<() => void>()

function set(next: AiReviewSnapshot): void {
  value = next
  for (const l of listeners) l()
}

function start(): void {
  if (started) return
  started = true
  window.hub.aiReview.onChanged(set)
  void window.hub.aiReview.get().then(set, () => undefined)
}

export function useAiReviews(): AiReviewSnapshot | null {
  useEffect(start, [])
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => value
  )
}

/** The session's review on screen: the live one first, else the most recently updated of its branches. */
export function reviewForSession(snap: AiReviewSnapshot | null, view: Pick<SessionView, 'id' | 'identity' | 'agentSessionId'>): AiReviewView | undefined {
  if (!snap) return undefined
  const identity = sessionIdentity(view)
  const mine = snap.reviews.filter((r) => r.devIdentity === identity)
  return mine.find((r) => r.status === 'reviewing') ?? [...mine].sort((a, b) => b.updatedAt - a.updatedAt)[0]
}

export function holdForSession(snap: AiReviewSnapshot | null, view: Pick<SessionView, 'id' | 'identity' | 'agentSessionId'>): AiReviewHold | undefined {
  const identity = sessionIdentity(view)
  return snap?.holds.find((h) => h.devIdentity === identity)
}

/** The "Review with another agent" loops pushed by the main process. */
let loops: ReviewLoopView[] = []
let loopsStarted = false
const loopListeners = new Set<() => void>()

function setLoops(next: ReviewLoopView[]): void {
  loops = next
  for (const l of loopListeners) l()
}

function startLoops(): void {
  if (loopsStarted) return
  loopsStarted = true
  window.hub.aiReview.onLoopsChanged(setLoops)
  void window.hub.aiReview.loops().then(setLoops, () => undefined)
}

export function useReviewLoops(): ReviewLoopView[] {
  useEffect(startLoops, [])
  return useSyncExternalStore(
    (l) => {
      loopListeners.add(l)
      return () => loopListeners.delete(l)
    },
    () => loops
  )
}

/** The loop a session takes part in, as the author or as the reviewer: the newest one. */
export function loopForSession(list: readonly ReviewLoopView[], sessionId: string): ReviewLoopView | undefined {
  return [...list].filter((l) => l.authorSessionId === sessionId || l.reviewerSessionId === sessionId).sort((a, b) => b.startedAt - a.startedAt)[0]
}
