import { useSyncExternalStore } from 'react'
import type { ConversationEntry, SubagentSummary } from '@workhub/core'

/**
 * Which sub-agent conversation is open, if any: one session at a time, with a stack so a
 * sub-agent opened from another one can go back to it.
 */
export interface OpenSubagent {
  sessionId: string
  stack: string[]
}

let open: OpenSubagent | null = null
const listeners = new Set<() => void>()

function set(next: OpenSubagent | null): void {
  open = next
  for (const l of listeners) l()
}

/** Opens a sub-agent; `nested` keeps the current one to go back to. */
export function openSubagent(sessionId: string, subagentId: string, nested = false): void {
  set(nested && open?.sessionId === sessionId ? { sessionId, stack: [...open.stack, subagentId] } : { sessionId, stack: [subagentId] })
}

export function backSubagent(): void {
  if (open && open.stack.length > 1) set({ ...open, stack: open.stack.slice(0, -1) })
}

export function closeSubagent(): void {
  set(null)
}

export function useOpenSubagent(): OpenSubagent | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => open
  )
}

/** The sub-agent a parent's Task/Agent call started, by the call id. */
export function subagentOfCall(subagents: SubagentSummary[] | undefined, toolCallId: string): SubagentSummary | undefined {
  return subagents?.find((s) => s.toolUseId === toolCallId)
}

/** Entries shown at first; earlier ones wait behind "Show earlier steps". */
export const ENTRY_PAGE = 150

/** The slice of entries to render: the last `shown`, and how many stay hidden before them. */
export function visibleEntries(entries: ConversationEntry[], shown: number): { hidden: number; list: ConversationEntry[] } {
  const hidden = Math.max(0, entries.length - shown)
  return { hidden, list: hidden ? entries.slice(hidden) : entries }
}

/** "4 s", "1 min 3 s", "2 h 5 min": short durations for thinking time and run time. */
export function shortDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${Math.max(1, s)} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ${s % 60} s`
  return `${Math.floor(m / 60)} h ${m % 60} min`
}

/** How long a sub-agent that ended stays listed under its session in the sidebar (Workhub 1's retention). */
export const SUBAGENT_RETENTION_MS = 5 * 60_000

/**
 * The sub-agents the sidebar lists under a session: every one at work, and the ones that ended
 * less than `SUBAGENT_RETENTION_MS` after their last activity. Most recent first.
 */
export function visibleSubagents(subagents: readonly SubagentSummary[] | undefined, now: number): SubagentSummary[] {
  const last = (s: SubagentSummary) => s.lastActivityAt ?? s.startedAt
  return (subagents ?? [])
    .filter((s) => isLive(s.status) || (last(s) !== undefined && now - last(s)! < SUBAGENT_RETENTION_MS))
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
}

/** Polling the transcript while the sub-agent may still write to it. */
export function isLive(status: string | undefined): boolean {
  return status === undefined || status === 'running' || status === 'background'
}
