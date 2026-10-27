import { useEffect, useState } from 'react'
import type { SessionView } from '@shared/api'

/** What a session is called: the name the user gave it, else its agent's name. */
export function sessionTitle(view: Pick<SessionView, 'name' | 'agentName'>): string {
  return view.name || view.agentName
}

/** Ids of the sessions shown in windows of their own, kept current. */
export function useDetachedSessions(): ReadonlySet<string> {
  const [ids, setIds] = useState<ReadonlySet<string>>(() => new Set())
  useEffect(() => {
    let alive = true
    const off = window.hub.windows.onDetached((list) => setIds(new Set(list)))
    void window.hub.windows.detached().then((list) => alive && setIds(new Set(list)))
    return () => {
      alive = false
      off()
    }
  }, [])
  return ids
}

/** Hash of a session window: `#session?id=<session id>`. */
export function parseSessionWindowHash(hash: string): { sessionId: string } | null {
  const m = /^#session\?(.*)$/.exec(hash)
  if (!m) return null
  const id = new URLSearchParams(m[1]).get('id')
  return id ? { sessionId: id } : null
}

/** Hash of a sub-agent window: `#subagent?session=<session id>&id=<subagent id>`. */
export function parseSubagentWindowHash(hash: string): { sessionId: string; subagentId: string } | null {
  const m = /^#subagent\?(.*)$/.exec(hash)
  if (!m) return null
  const params = new URLSearchParams(m[1])
  const sessionId = params.get('session')
  const subagentId = params.get('id')
  return sessionId && subagentId ? { sessionId, subagentId } : null
}
