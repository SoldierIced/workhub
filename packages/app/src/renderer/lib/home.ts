import type { ConnectionKind, PlanUsageWindow, Profile, SessionMonitorSnapshot, SessionState } from '@workhub/core'
import type { AccountUsage } from '@shared/api'
import type { ChatItem } from '../store'

/** What a session needs from the user, as the Home "Needs you" tiles group it (Workhub 1's four tiles). */
export type Attention = 'needsReply' | 'ready' | 'working' | 'error'
export const ATTENTION_ORDER: readonly Attention[] = ['needsReply', 'ready', 'working', 'error']

/** The parts of a session the Home screen reads. */
export interface SessionSummary {
  view: { id: string; state: SessionState; cwd: string; startedAt: number; agentId?: string; accountId?: string | null; accountName?: string }
  items: ChatItem[]
  monitor: SessionMonitorSnapshot
}

/**
 * - needsReply: a permission request is waiting for an answer.
 * - error: the session failed.
 * - working: starting or running a prompt.
 * - ready: idle after the agent answered (the turn is there to read).
 * A stopped session, or an idle one nobody prompted yet, needs nothing.
 */
export function attentionOf(s: SessionSummary): Attention | null {
  if (s.items.some((i) => i.kind === 'permission' && i.answer === undefined)) return 'needsReply'
  switch (s.view.state) {
    case 'error':
      return 'error'
    case 'starting':
    case 'busy':
      return 'working'
    case 'ready': {
      const last = [...s.items].reverse().find((i) => i.kind !== 'turnEnd')
      return last && (last.kind === 'agent' || last.kind === 'tool' || last.kind === 'thought') ? 'ready' : null
    }
    default:
      return null
  }
}

export function groupByAttention<T extends SessionSummary>(sessions: T[]): Record<Attention, T[]> {
  const out: Record<Attention, T[]> = { needsReply: [], ready: [], working: [], error: [] }
  for (const s of sessions) {
    const a = attentionOf(s)
    if (a) out[a].push(s)
  }
  for (const list of Object.values(out)) list.sort((a, b) => b.view.startedAt - a.view.startedAt)
  return out
}

/** Whether the active profile has a connection of a kind; screens for that kind say "connect it" otherwise. */
export function hasConnection(profile: Profile | undefined, kind: ConnectionKind): boolean {
  return Boolean(profile?.connections[kind])
}

/** Last segment of a path, for either separator (paths come from macOS, Windows or Linux). */
export function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

/** Plan usage windows reported by any session, keeping the highest percent per window. */
export function planUsage(sessions: SessionSummary[]): PlanUsageWindow[] {
  const byWindow = new Map<string, PlanUsageWindow>()
  for (const s of sessions) {
    for (const w of s.monitor.planUsage ?? []) {
      const prev = byWindow.get(w.window)
      if (!prev || w.percent > prev.percent) byWindow.set(w.window, w)
    }
  }
  return [...byWindow.values()]
}

/** Plan usage of one account, as the sidebar card shows it. `name` is empty for the default folder. */
export interface UsageGroup {
  key: string
  name: string
  windows: PlanUsageWindow[]
  error?: string
}

/**
 * Plan usage per account: what running sessions reported, replaced by the account's own read
 * when the user turned that read on (Settings → Usage). Accounts without data are left out.
 */
export function usageGroups(sessions: SessionSummary[], reads: AccountUsage[]): UsageGroup[] {
  const groups = new Map<string, UsageGroup>()
  for (const s of sessions) {
    if (!s.monitor.planUsage?.length) continue
    const key = s.view.accountId ?? ''
    const g = groups.get(key) ?? { key, name: s.view.accountName ?? '', windows: [] }
    g.windows = planUsage([{ ...s, monitor: { planUsage: [...g.windows, ...s.monitor.planUsage] } }])
    groups.set(key, g)
  }
  // The sidebar card stays on Claude accounts; Home's "Usage by agent" lists every agent.
  for (const r of reads.filter((x) => x.agentId === 'claude')) {
    const key = r.accountId ?? ''
    if (r.windows.length) groups.set(key, { key, name: r.name, windows: r.windows })
    else if (r.error && !groups.has(key)) groups.set(key, { key, name: r.name, windows: [], error: r.error })
  }
  return [...groups.values()]
}

/** Distinct folders: the profile's own first (in its order), then session folders, most recently used first. */
export function recentFolders(sessions: SessionSummary[], profileFolders: string[] = []): string[] {
  const seen = new Set<string>(profileFolders)
  for (const s of [...sessions].sort((a, b) => b.view.startedAt - a.view.startedAt)) seen.add(s.view.cwd)
  return [...seen]
}

/** Compact token counts: 950, 12.3k, 5.5M. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}
