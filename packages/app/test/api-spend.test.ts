import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { emptyConfig, localDayKey, type WorkhubConfig } from '@workhub/core'
import { TokenSpendScanner } from '@workhub/adapters/token-spend'
import { apiKeyClaudeDirs, ApiSpendService, billedByApiKey, CostLedger, type CostLedgerState } from '../src/main/api-spend'

const NOW = new Date(2026, 9, 27, 15).getTime()
const TODAY = localDayKey(new Date(NOW))

function memory(initial?: CostLedgerState) {
  let value = initial
  return { load: (fallback: CostLedgerState) => value ?? fallback, save: (v: CostLedgerState) => void (value = structuredClone(v)), get value() { return value } }
}

describe('which Claude folders run on an API key', () => {
  it('picks accounts whose environment sets ANTHROPIC_API_KEY, and the default one from Workhub’s', () => {
    const config: WorkhubConfig = {
      ...emptyConfig(),
      accounts: [
        { id: 'api', agentId: 'claude', name: 'API', configDir: '/h/.claude-api', env: { ANTHROPIC_API_KEY: 'secret-ref' } },
        { id: 'pro', agentId: 'claude', name: 'Pro', configDir: '/h/.claude-pro' }
      ]
    }
    expect(apiKeyClaudeDirs(config, '/h', {})).toEqual([resolve('/h/.claude-api')])
    expect(apiKeyClaudeDirs(config, '/h', { ANTHROPIC_API_KEY: 'x' }).sort()).toEqual([resolve('/h/.claude'), resolve('/h/.claude-api'), resolve('/h/.claude-pro')].sort())
  })

  it('bills Codex rollouts without plan limits and Claude transcripts in API folders', () => {
    const entry = { size: 0, mtimeMs: 0, offset: 0, buckets: {} }
    expect(billedByApiKey('/h/.codex/sessions/2026/10/27/rollout-x.jsonl', entry, [])).toBe(true)
    expect(billedByApiKey('/h/.codex/sessions/2026/10/27/rollout-x.jsonl', { ...entry, state: { plan: true } }, [])).toBe(false)
    expect(billedByApiKey(resolve('/h/.claude-api/projects/p/s.jsonl'), entry, [resolve('/h/.claude-api')])).toBe(true)
    expect(billedByApiKey(resolve('/h/.claude-api2/projects/p/s.jsonl'), entry, [resolve('/h/.claude-api')])).toBe(false)
  })
})

describe('the cost ledger', () => {
  it('adds the growth of each session’s running cost per day, and skips agents read from files', () => {
    const store = memory()
    const ledger = new CostLedger(store, () => NOW)
    ledger.record('gemini', 's1', 0.5)
    ledger.record('gemini', 's1', 0.5)
    ledger.record('gemini', 's1', 1.25)
    ledger.record('gemini', 's2', 0.25)
    ledger.record('opencode', 's3', 9)
    ledger.record('claude', 's4', 9)
    expect(ledger.entries()).toEqual([{ agent: 'gemini', day: TODAY, usd: 1.5 }])
    // After a restart, a resumed session reporting its running total adds nothing again.
    const again = new CostLedger(memory(store.value), () => NOW)
    again.record('gemini', 's1', 1.25)
    expect(again.entries()).toEqual([{ agent: 'gemini', day: TODAY, usd: 1.5 }])
  })
})

describe('the API spend service', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('joins API-key transcripts, OpenCode and the ledger, and leaves plan sessions out', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wh-api-'))
    dirs.push(root)
    const at = new Date(NOW - 3_600_000).toISOString()
    const claudeLine = (id: string) => JSON.stringify({ type: 'assistant', cwd: '/w', timestamp: at, message: { id, model: 'claude-sonnet-4-5', usage: { input_tokens: 1_000_000, output_tokens: 0 } } })
    for (const [dir, id] of [['.claude-api', 'a'], ['.claude-pro', 'b']] as const) {
      mkdirSync(join(root, dir, 'projects', 'p'), { recursive: true })
      writeFileSync(join(root, dir, 'projects', 'p', `${id}.jsonl`), `${claudeLine(id)}\n`)
    }
    const config: WorkhubConfig = {
      ...emptyConfig(),
      accounts: [
        { id: 'api', agentId: 'claude', name: 'API', configDir: join(root, '.claude-api'), env: { ANTHROPIC_API_KEY: 'ref' } },
        { id: 'pro', agentId: 'claude', name: 'Pro', configDir: join(root, '.claude-pro') }
      ]
    }
    const scanner = new TokenSpendScanner()
    const since = NOW - 6 * 86_400_000
    await scanner.scan({ claudeDirs: [join(root, '.claude-api'), join(root, '.claude-pro')], codexHomes: [], kiroDirs: [] }, since, localDayKey(new Date(since)))
    const ledger = new CostLedger(memory(), () => NOW)
    ledger.record('gemini', 's', 0.4)
    const svc = new ApiSpendService({
      config: async () => config,
      home: root,
      env: {},
      costs: (include) => scanner.costs(localDayKey(new Date(since)), include),
      ledger,
      openCode: async () => [{ at: NOW - 60_000, usd: 0.75, tokens: 10 }],
      now: () => NOW
    })
    const out = await svc.summary()
    expect(out.map((a) => [a.agent, a.today, a.week])).toEqual([
      ['claude', 3, 3],
      ['opencode', 0.75, 0.75],
      ['gemini', 0.4, 0.4]
    ])
  })
})
