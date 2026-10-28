import { useCallback, useEffect, useRef, useState } from 'react'
import { useToast } from '../components/molecules'
import { errorText } from './errorText'

/**
 * Feedback for a button that calls the main process: `pending` while the call runs (disable the
 * control, swap its icon for a spinner), a danger toast when it rejects, and a second click ignored
 * until the first settles. `action` may change between renders; the latest one runs.
 */
export function useAsyncAction<A extends unknown[]>(action: (...args: A) => Promise<unknown>): { run: (...args: A) => void; pending: boolean } {
  const toast = useToast()
  const [pending, setPending] = useState(false)
  const latest = useRef(action)
  latest.current = action
  const busy = useRef(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const run = useCallback(
    (...args: A) => {
      if (busy.current) return
      busy.current = true
      setPending(true)
      void latest
        .current(...args)
        .catch((e: unknown) => alive.current && toast(errorText(e), 'danger'))
        .finally(() => {
          busy.current = false
          if (alive.current) setPending(false)
        })
    },
    [toast]
  )
  return { run, pending }
}
