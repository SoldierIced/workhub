/**
 * Spend of agents billed by API key (no plan window): OpenCode, Codex or Claude Code signed in
 * with an API key, any ACP agent that reports a cost. Per agent, per local day, in USD, from what
 * their transcripts or session updates report (a cost, or tokens priced with a bundled table).
 * Pure: the callers read the sources.
 */
import { localDayKey, startOfLocalDay } from './credits'

/** What one source spent on one local day. */
export interface ApiSpendEntry {
  /** The agent id (`opencode`, `codex`, `claude`, an ACP agent's id). */
  agent: string
  /** Local calendar day, `YYYY-MM-DD`. */
  day: string
  usd: number
  /** Fresh tokens behind `usd`, when known. */
  tokens?: number
  /** Tokens of a model missing from the price table: spent, but not in `usd`. */
  unpricedTokens?: number
}

export interface ApiSpendDay {
  day: string
  usd: number
}

export interface ApiAgentSpend {
  agent: string
  /** Since local midnight. */
  today: number
  /** The last 7 local days, today included. */
  week: number
  /** The last 7 local days, oldest first (0 when nothing was spent). */
  days: ApiSpendDay[]
  tokens: number
  /** Tokens over the week that could not be priced (their model is not in the table). */
  unpricedTokens: number
}

const DAYS = 7

/** Spend per agent over the last 7 days, the biggest week first; agents with nothing spent are left out. */
export function apiSpendSummary(entries: readonly ApiSpendEntry[], now: number): ApiAgentSpend[] {
  const keys: string[] = []
  for (let i = DAYS - 1; i >= 0; i--) keys.push(localDayKey(new Date(startOfLocalDay(now, i))))
  const today = keys[keys.length - 1]
  const byAgent = new Map<string, ApiAgentSpend>()
  for (const e of entries) {
    if (!keys.includes(e.day)) continue
    const usd = Number.isFinite(e.usd) && e.usd > 0 ? e.usd : 0
    const tokens = Number.isFinite(e.tokens) && (e.tokens ?? 0) > 0 ? e.tokens! : 0
    const unpriced = Number.isFinite(e.unpricedTokens) && (e.unpricedTokens ?? 0) > 0 ? e.unpricedTokens! : 0
    if (!usd && !unpriced) continue
    let a = byAgent.get(e.agent)
    if (!a) {
      a = { agent: e.agent, today: 0, week: 0, days: keys.map((day) => ({ day, usd: 0 })), tokens: 0, unpricedTokens: 0 }
      byAgent.set(e.agent, a)
    }
    a.week += usd
    if (e.day === today) a.today += usd
    a.days.find((d) => d.day === e.day)!.usd += usd
    a.tokens += tokens + unpriced
    a.unpricedTokens += unpriced
  }
  return [...byAgent.values()].sort((x, y) => y.week - x.week || x.agent.localeCompare(y.agent))
}
