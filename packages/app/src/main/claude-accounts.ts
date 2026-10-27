import { join, resolve } from 'node:path'
import { accountAgentId, type PlanUsageReader, type WorkhubConfig } from '@workhub/core'
import type { AccountUsage } from '../shared/api'

export interface ClaudeAccountRef {
  /** Null: Claude Code's own default folder, used by sessions without an account. */
  accountId: string | null
  /** Empty for the default folder; the renderer names it. */
  name: string
  configDir?: string
}

/**
 * Every Claude config folder Workhub knows: each Claude account, plus the default folder
 * (`CLAUDE_CONFIG_DIR` or `~/.claude`) unless an account already is it. One entry per folder.
 */
export function claudeAccounts(config: WorkhubConfig, home: string, envConfigDir = process.env['CLAUDE_CONFIG_DIR']): ClaudeAccountRef[] {
  const defaultDir = resolve(envConfigDir || join(home, '.claude'))
  const seen = new Set<string>()
  const out: ClaudeAccountRef[] = []
  for (const a of config.accounts.filter((x) => x.agentId === accountAgentId({ id: 'claude' }))) {
    const dir = a.configDir ? resolve(a.configDir) : defaultDir
    if (seen.has(dir)) continue
    seen.add(dir)
    out.push({ accountId: a.id, name: a.name, configDir: a.configDir })
  }
  if (!seen.has(defaultDir)) out.unshift({ accountId: null, name: '' })
  return out
}

/** Reads plan usage per Claude account while the user has the option on (Settings → General). */
export class UsageService {
  private last: AccountUsage[] = []
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly reader: PlanUsageReader,
    private readonly accounts: () => Promise<{ enabled: boolean; accounts: ClaudeAccountRef[] }>,
    private readonly emit: (usage: AccountUsage[]) => void,
    private readonly intervalMs = 5 * 60_000
  ) {}

  start(): void {
    void this.refresh()
    this.timer = setInterval(() => void this.refresh(), this.intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  current(): AccountUsage[] {
    return this.last
  }

  async refresh(): Promise<AccountUsage[]> {
    const { enabled, accounts } = await this.accounts()
    if (!enabled) {
      if (this.last.length) this.emit((this.last = []))
      return this.last
    }
    this.last = await Promise.all(
      accounts.map(async (a): Promise<AccountUsage> => {
        try {
          return { accountId: a.accountId, name: a.name, windows: await this.reader.read(a.configDir), at: Date.now() }
        } catch (err) {
          return { accountId: a.accountId, name: a.name, windows: [], error: err instanceof Error ? err.message : String(err), at: Date.now() }
        }
      })
    )
    this.emit(this.last)
    return this.last
  }
}
