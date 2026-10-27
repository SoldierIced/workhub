import { useEffect, useState } from 'react'
import { historyId } from '@workhub/core'
import type { HistoryItem } from '@shared/api'
import { errorText } from './errorText'

export interface PastSessionsState {
  entries: HistoryItem[]
  /** `historyId`s of the sessions open now, to leave out of the past list. */
  open: ReadonlySet<string>
  loading: boolean
  error?: string
}

/** The session history, read once when the view opens, plus which of those sessions are open now. */
export function usePastSessions(): PastSessionsState {
  const [state, setState] = useState<PastSessionsState>({ entries: [], open: new Set(), loading: true })
  useEffect(() => {
    let cancelled = false
    void Promise.all([window.hub.history.list(), window.hub.sessions.list()]).then(
      ([history, live]) => {
        if (cancelled) return
        const open = new Set(live.filter((s) => s.state !== 'stopped' && s.state !== 'error' && s.agentSessionId).map((s) => historyId({ agentId: s.agentId, agentSessionId: s.agentSessionId! })))
        setState({ entries: history.entries, open, loading: false })
      },
      (e: unknown) => {
        if (!cancelled) setState({ entries: [], open: new Set(), loading: false, error: errorText(e) })
      }
    )
    return () => {
      cancelled = true
    }
  }, [])
  return state
}
