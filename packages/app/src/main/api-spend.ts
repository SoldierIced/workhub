/**
 * Spend of agents billed by API key, per agent and per day (PLAN §9 "Spend for API-key agents"):
 *
 * - Claude Code accounts whose environment sets `ANTHROPIC_API_KEY` (the key itself is never read,
 *   only whether it is set): their transcripts priced with the Claude table.
 * - Codex sessions that report no ChatGPT plan rate limits (an API key has none): priced with the
 *   bundled OpenAI table.
 * - OpenCode: the cost it records per message (0 for subscriptions, so those stay out).
 * - Any other agent that reports a cost in its session updates (ACP `usage_update.cost`): the
 *   growth of each session's running cost, kept per day in a small ledger.
 *
 * Nothing is fetched from the network: prices are bundled tables.
 */
import { basename, join, resolve, sep } from 'node:path'
import { readOpenCodeCosts } from '@workhub/adapters/transcript-opencode'
import type { SpendFileEntry, CodexSpendState } from '@workhub/adapters/token-spend'
import {
  accountAgentId,
  apiSpendSummary,
  knownAgents,
  launchEnvironment,
  localDayKey,
  parseSpendKey,
  startOfLocalDay,
  type AgentDefinition,
  type ApiAgentSpend,
  type ApiSpendEntry,
  type SpendBuckets,
  type WorkhubConfig
} from '@workhub/core'
import { usageAccounts } from './agent-usage'

/** Agents whose spend comes from their transcripts or database, never from the ledger. */
const FROM_FILES = new Set(['claude', 'codex', 'opencode', 'kiro'])

/** The Claude config folders whose sessions run on an API key (`ANTHROPIC_API_KEY` set for them). */
export function apiKeyClaudeDirs(config: WorkhubConfig, home: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const agent = knownAgents(config).find((a) => a.id === 'claude')
  if (!agent) return []
  const out = new Set<string>()
  for (const ref of usageAccounts(config, 'claude', home, env)) {
    const account = ref.accountId ? (config.accounts.find((a) => a.id === ref.accountId) ?? null) : null
    // Sessions get Workhub's environment plus the agent's and the account's own.
    const vars = { ...env, ...launchEnvironment(agent, account) }
    if (vars['ANTHROPIC_API_KEY']) out.add(resolve(ref.configDir ?? join(home, '.claude')))
  }
  return [...out]
}

/** Whether a scanned transcript is billed by API key. */
export function billedByApiKey(path: string, entry: SpendFileEntry, claudeDirs: readonly string[]): boolean {
  if (basename(path).startsWith('rollout-')) return !(entry.state as CodexSpendState | undefined)?.plan
  return claudeDirs.some((d) => path.startsWith(d + sep))
}

/** Day entries from cost buckets (`day \t agent \t path` keys). */
export function bucketEntries(usd: SpendBuckets, unpriced: SpendBuckets, tokens: SpendBuckets): ApiSpendEntry[] {
  const by = new Map<string, ApiSpendEntry>()
  const add = (set: SpendBuckets, field: 'usd' | 'unpricedTokens' | 'tokens') => {
    for (const [key, value] of Object.entries(set)) {
      const k = parseSpendKey(key)
      if (!k) continue
      const id = `${k.day}\t${k.agent}`
      let e = by.get(id)
      if (!e) {
        e = { agent: k.agent, day: k.day, usd: 0, tokens: 0, unpricedTokens: 0 }
        by.set(id, e)
      }
      e[field] = (e[field] ?? 0) + value
    }
  }
  add(usd, 'usd')
  add(unpriced, 'unpricedTokens')
  add(tokens, 'tokens')
  // `tokens` holds every fresh token; keep only the priced part there.
  for (const e of by.values()) e.tokens = Math.max(0, (e.tokens ?? 0) - (e.unpricedTokens ?? 0))
  return [...by.values()]
}

export interface CostLedgerState {
  /** The last running cost seen per agent session (`agent \t session`), with when. */
  last: Record<string, { usd: number; at: number }>
  /** USD per `day \t agent`. */
  days: Record<string, number>
}

/**
 * The cost other agents report in their session updates, per day: each update carries the
 * session's running cost, so the growth since the previous one is added. Persisted, so a session
 * resumed after a restart does not count its earlier cost again.
 */
export class CostLedger {
  private state: CostLedgerState

  constructor(
    private readonly store: { load(fallback: CostLedgerState): CostLedgerState; save(value: CostLedgerState): void },
    private readonly now: () => number = Date.now
  ) {
    const s = store.load({ last: {}, days: {} })
    this.state = { last: { ...(s?.last ?? {}) }, days: { ...(s?.days ?? {}) } }
  }

  /** A session reported its running cost (USD). Agents read from their files are skipped. */
  record(agent: string, session: string, usd: number): void {
    if (FROM_FILES.has(agent) || !Number.isFinite(usd) || usd < 0) return
    const key = `${agent}\t${session}`
    const now = this.now()
    const prev = this.state.last[key]?.usd ?? 0
    // A running cost that went down started over (a new session under the same id).
    const delta = usd >= prev ? usd - prev : usd
    this.state.last[key] = { usd, at: now }
    if (delta > 0) {
      const day = `${localDayKey(new Date(now))}\t${agent}`
      this.state.days[day] = (this.state.days[day] ?? 0) + delta
    }
    this.prune(now)
    this.store.save(this.state)
  }

  entries(): ApiSpendEntry[] {
    return Object.entries(this.state.days).flatMap(([key, usd]) => {
      const [day, agent] = key.split('\t')
      return day && agent ? [{ agent, day, usd }] : []
    })
  }

  private prune(now: number): void {
    const since = localDayKey(new Date(startOfLocalDay(now, 7)))
    for (const key of Object.keys(this.state.days)) if (key.slice(0, 10) < since) delete this.state.days[key]
    for (const [key, v] of Object.entries(this.state.last)) if (now - v.at > 30 * 86_400_000) delete this.state.last[key]
  }
}

/** The agent id spend is kept under: an agent running another one's accounts (Claude over ACP) counts as that one. */
export function spendAgentId(agent: AgentDefinition | undefined, agentId: string): string {
  return agent ? accountAgentId(agent) : agentId
}

export interface ApiSpendDeps {
  config: () => Promise<WorkhubConfig>
  home: string
  /** The scanned transcripts' cost (see `TokenSpendService.costs`). */
  costs: (include: (path: string, entry: SpendFileEntry) => boolean) => { usd: SpendBuckets; unpriced: SpendBuckets; tokens: SpendBuckets }
  ledger: CostLedger
  openCode?: (since: number) => Promise<{ at: number; usd: number; tokens: number }[]>
  env?: NodeJS.ProcessEnv
  now?: () => number
}

/** Spend per API-billed agent over the last 7 days, read at most once a minute. */
export class ApiSpendService {
  private cache: { at: number; value: ApiAgentSpend[] } | null = null

  constructor(private readonly deps: ApiSpendDeps) {}

  async summary(): Promise<ApiAgentSpend[]> {
    const now = this.deps.now?.() ?? Date.now()
    if (this.cache && now - this.cache.at < 60_000) return this.cache.value
    const config = await this.deps.config()
    const claudeDirs = apiKeyClaudeDirs(config, this.deps.home, this.deps.env)
    const scanned = this.deps.costs((path, entry) => billedByApiKey(path, entry, claudeDirs))
    const openCode = await (this.deps.openCode ?? ((since) => readOpenCodeCosts({ since })))(startOfLocalDay(now, 6)).catch(() => [])
    const entries: ApiSpendEntry[] = [
      ...bucketEntries(scanned.usd, scanned.unpriced, scanned.tokens),
      ...openCode.map((e) => ({ agent: 'opencode', day: localDayKey(new Date(e.at)), usd: e.usd, tokens: e.tokens })),
      ...this.deps.ledger.entries()
    ]
    const value = apiSpendSummary(entries, now)
    this.cache = { at: now, value }
    return value
  }
}
