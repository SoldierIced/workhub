import { useCallback, useEffect, useRef, useState } from 'react'

/** The shortest spin a click shows: a load answered from cache must still read as "it did something". */
export const MIN_REFRESH_SPIN_MS = 600

/**
 * Runs `run` one at a time: a call made while the previous one is pending does nothing. A rejection
 * is swallowed (the caller shows its own errors); `onBusy` follows the run either way, for at
 * least `minMs`.
 */
export function createRefreshGuard(run: () => unknown, onBusy: (busy: boolean) => void, minMs = 0): () => Promise<void> {
  let busy = false
  return async () => {
    if (busy) return
    busy = true
    onBusy(true)
    const started = Date.now()
    try {
      await run()
    } catch {
      // Nothing to add: whoever owns the load reports its failure.
    } finally {
      const left = minMs - (Date.now() - started)
      if (left > 0) await new Promise((resolve) => setTimeout(resolve, left))
      busy = false
      onBusy(false)
    }
  }
}

/**
 * Tracks a refresh handler that returns a promise: `busy` lasts until it settles and a click made
 * meanwhile is ignored, even one that lands before React re-renders.
 */
export function useRefreshGuard(onRefresh: (() => unknown) | undefined): { busy: boolean; trigger: () => void } {
  const [busy, setBusy] = useState(false)
  const handler = useRef(onRefresh)
  handler.current = onRefresh
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  const guard = useRef<() => Promise<void>>(undefined)
  if (!guard.current) guard.current = createRefreshGuard(() => handler.current?.(), (b) => live.current && setBusy(b), MIN_REFRESH_SPIN_MS)
  const trigger = useCallback(() => void guard.current?.(), [])
  return { busy, trigger }
}
