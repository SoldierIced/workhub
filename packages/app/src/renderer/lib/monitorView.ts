import type { ContextUsage, LocalChanges, PullRequestItem, RepoChanges, SubagentSummary, ToolCallSummary } from '@workhub/core'

/**
 * The session monitor's view model (Workhub 1's InspectorView): its sections in the owner's order,
 * and the numbers each board shows, computed from what the session already reports.
 */

/** Section ids in Workhub 1's order: Slack first, then tickets, pull requests, the boards, MCP, local work. */
export const MONITOR_SECTIONS = [
  'slack',
  'tickets',
  'pullRequests',
  'sessionTime',
  'tokens',
  'context',
  'sessionBudget',
  'requests',
  'activity',
  'subagents',
  'touchedPrs',
  'mcp',
  'localChanges',
  'review'
] as const
export type MonitorSection = (typeof MONITOR_SECTIONS)[number]

export interface SessionTime {
  aliveMs: number
  activeMs: number
  toolMs: number
  thinkingMs: number
  idleMs: number
  /** Active share of the session, 0-100. */
  activePercent: number
}

/** Time spent in tool calls: finished calls by their own span, a running one up to `now`. */
export function toolTimeMs(calls: readonly ToolCallSummary[] | undefined, now: number): number {
  let ms = 0
  for (const c of calls ?? []) {
    if (c.startedAt === undefined) continue
    const end = c.endedAt ?? (c.status === 'pending' || c.status === 'in_progress' ? now : undefined)
    if (end !== undefined && end > c.startedAt) ms += end - c.startedAt
  }
  return ms
}

/** Alive, active, tools, thinking and idle time (Workhub 1's "Session time" board). */
export function sessionTime(startedAt: number, now: number, activeMs: number | undefined, calls: readonly ToolCallSummary[] | undefined): SessionTime {
  const aliveMs = Math.max(now - startedAt, 1)
  const active = Math.min(Math.max(activeMs ?? 0, 0), aliveMs)
  const toolMs = Math.min(toolTimeMs(calls, now), active || aliveMs)
  return {
    aliveMs,
    activeMs: active,
    toolMs,
    thinkingMs: Math.max(active - toolMs, 0),
    idleMs: Math.max(aliveMs - active, 0),
    activePercent: Math.round((active / aliveMs) * 100)
  }
}

export interface ContextView {
  used?: number
  size?: number
  /** 0-1. */
  fraction: number
  /** Over 80% of the window: shown in orange, as Workhub 1 does. */
  high: boolean
}

/** The context window board; null when the agent reports nothing usable. */
export function contextView(ctx: ContextUsage | undefined): ContextView | null {
  if (!ctx) return null
  const fraction = ctx.percent !== undefined ? ctx.percent / 100 : ctx.used !== undefined && ctx.size ? ctx.used / ctx.size : undefined
  if (fraction === undefined || !Number.isFinite(fraction)) return null
  const clamped = Math.min(Math.max(fraction, 0), 1)
  return { used: ctx.used, size: ctx.size, fraction: clamped, high: clamped > 0.8 }
}

/** Tokens of every subagent together (the "Of which subagents" row). */
export function subagentTokens(subagents: readonly SubagentSummary[] | undefined): number | undefined {
  const known = (subagents ?? []).map((s) => s.tokens?.total).filter((n): n is number => n !== undefined)
  return known.length ? known.reduce((a, b) => a + b, 0) : undefined
}

/** `https://github.com/acme/web/pull/12` → `acme/web#12`; GitLab's `/-/merge_requests/12` → `group/app!12`. */
export function pullRequestLabel(url: string): string {
  const gh = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url)
  if (gh) return `${gh[1]}#${gh[2]}`
  const gl = /^https?:\/\/[^/]+\/(.+?)\/-\/merge_requests\/(\d+)/.exec(url)
  if (gl) return `${gl[1]}!${gl[2]}`
  return url.replace(/^https?:\/\/(www\.)?/, '')
}

export interface ChangesTotal {
  repos: number
  files: number
  additions: number
  deletions: number
}

/** The changes summed over the repositories read (one, or the ones with changes in a folder of repos). */
export function changesTotal(changes: LocalChanges): ChangesTotal {
  return changes.repos.reduce<ChangesTotal>(
    (t, r) => ({ repos: t.repos + (r.files > 0 ? 1 : 0), files: t.files + r.files, additions: t.additions + r.additions, deletions: t.deletions + r.deletions }),
    { repos: 0, files: 0, additions: 0, deletions: 0 }
  )
}

/** Branches every repository uses for releases: a PR from one of them is not this session's work. */
const SHARED_BRANCHES = new Set(['main', 'master', 'develop', 'dev', 'trunk'])

/**
 * The session's pull requests: the ones its tool calls touched, and the open ones of its
 * repositories' current branches (by repository name and branch), from the code host's lists.
 */
export function sessionPullRequests(items: readonly PullRequestItem[], touched: readonly string[] | undefined, repos: readonly RepoChanges[] | undefined): PullRequestItem[] {
  const urls = new Set(touched ?? [])
  const branches = new Set((repos ?? []).filter((r) => r.branch && !SHARED_BRANCHES.has(r.branch)).map((r) => `${r.name.toLowerCase()}@${r.branch}`))
  const out: PullRequestItem[] = []
  const seen = new Set<string>()
  for (const item of items) {
    const pr = item.pr
    if (seen.has(pr.url)) continue
    const repoName = pr.repo.split('/').pop()?.toLowerCase() ?? ''
    if (urls.has(pr.url) || (pr.state === 'open' && branches.has(`${repoName}@${pr.branch}`))) {
      seen.add(pr.url)
      out.push(item)
    }
  }
  return out
}

/** Tickets of the session's PRs first, then the ones named in the conversation, without repeats. */
export function sessionTicketKeys(prs: readonly PullRequestItem[], mentioned: readonly string[] | undefined): string[] {
  return [...new Set([...prs.flatMap((p) => p.ticketKeys), ...(mentioned ?? [])])]
}

/** New width of a panel dragged by its left edge from `startX` to `x`, kept within `[min, max]`. */
export function dragWidth(startWidth: number, startX: number, x: number, min: number, max: number): number {
  return Math.round(Math.min(max, Math.max(min, startWidth + (startX - x))))
}

export interface RequestBars {
  bars: { value: number; fraction: number }[]
  max: number
}

/** The "New tokens per request" bars of the turn in progress; null unless the turn had more than one request. */
export function requestBars(requests: readonly number[] | undefined): RequestBars | null {
  if (!requests || requests.length < 2) return null
  const max = Math.max(...requests, 1)
  return { max, bars: requests.map((value) => ({ value, fraction: Math.max(value / max, 0.07) })) }
}
