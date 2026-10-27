import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { emptySpendCache, TokenSpendScanner, type SpendCache, type SpendSources } from '@workhub/adapters/token-spend'
import { folderSpend, ownsFolder, profileFolderPaths, SPEND_DAYS, spendWindowStart, startOfLocalDay, type SpendBuckets, type WorkhubConfig } from '@workhub/core'
import type { FolderSpendResult } from '../shared/api'
import { usageAccounts } from './agent-usage'
import { profileProjectChildren } from './workspaces'

/** Rescans every 10 minutes; a scan reads only what was appended since the previous one. */
const INTERVAL_MS = 10 * 60_000

export interface TokenSpendDeps {
  config: () => Promise<WorkhubConfig>
  /** Where the scanned state is kept between runs (`token-spend.json` in the data folder). */
  store: { load(fallback: SpendCache): SpendCache; save(value: SpendCache): void; flush(): void }
  sources: () => Promise<SpendSources>
  /** A scan finished: the renderer asks again for its profile's spend. */
  emit: () => void
  intervalMs?: number
  now?: () => number
  /** Expands `~` in the profiles' folders (the user's home by default). */
  home?: string
}

/**
 * Token spend per folder of each profile, for Home. Scans the transcripts in the background from
 * start-up and keeps the result cached on disk, so the card is ready when Home opens instead of
 * waiting for sessions to report tokens.
 */
export class TokenSpendService {
  private readonly scanner: TokenSpendScanner
  private buckets: SpendBuckets = {}
  private scannedAt: number | null = null
  private scanning = false
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly deps: TokenSpendDeps) {
    this.scanner = new TokenSpendScanner(deps.store.load(emptySpendCache()))
    // What the last run found, until the first scan of this run ends.
    this.buckets = this.scanner.cached(spendWindowStart(this.now()))
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  start(): void {
    if (this.timer) return
    void this.refresh()
    this.timer = setInterval(() => void this.refresh(), this.deps.intervalMs ?? INTERVAL_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.deps.store.flush()
  }

  async refresh(): Promise<void> {
    const now = this.now()
    this.scanning = true
    try {
      const sources = await this.deps.sources()
      this.buckets = await this.scanner.scan(sources, startOfLocalDay(now, SPEND_DAYS - 1), spendWindowStart(now))
      this.scannedAt = this.now()
      this.deps.store.save(this.scanner.snapshot())
    } catch {
      // A failed scan keeps the previous figures; the next one tries again.
    } finally {
      this.scanning = false
      this.deps.emit()
    }
  }

  /** The spend of one profile's folders over the last 7 days, largest first. */
  async forProfile(profileId: string | null | undefined): Promise<FolderSpendResult> {
    const config = await this.deps.config()
    const profile = config.profiles.find((p) => p.id === (profileId ?? config.activeProfileId)) ?? config.profiles[0]
    if (!profile) return { entries: [], days: SPEND_DAYS, scannedAt: this.scannedAt, scanning: this.scanning, hasFolders: false }
    const home = this.deps.home ?? homedir()
    const folders = profileFolderPaths(profile, home).map((f) => f.path)
    const children = await profileProjectChildren(profile, home)
    const owns = (path: string) => ownsFolder(profile.id, path, config.profiles, home)
    const entries = folderSpend(this.buckets, folders, { sinceDay: spendWindowStart(this.now()), children, owns })
    return { entries, days: SPEND_DAYS, scannedAt: this.scannedAt, scanning: this.scanning, hasFolders: folders.length > 0 || profile.ownsOutside === true }
  }
}

/**
 * Every transcript folder to scan: each Claude and Codex account's folder plus the defaults, the
 * other `~/.claude*` folders (Claude installs Workhub has no account for, as Workhub 1 read), and
 * Kiro's data folder.
 */
export async function spendSources(config: WorkhubConfig, home: string, kiroDir: string | undefined, env: NodeJS.ProcessEnv = process.env): Promise<SpendSources> {
  const dirs = (agentId: string, fallback: string) => usageAccounts(config, agentId, home, env).map((a) => resolve(a.configDir ?? join(home, fallback)))
  const claude = new Set(dirs('claude', '.claude'))
  if (!claude.size) claude.add(resolve(env['CLAUDE_CONFIG_DIR'] || join(home, '.claude')))
  for (const e of await readdir(home, { withFileTypes: true }).catch(() => [])) {
    if (e.isDirectory() && e.name.startsWith('.claude')) claude.add(join(home, e.name))
  }
  const codex = new Set(dirs('codex', '.codex'))
  if (!codex.size) codex.add(resolve(env['CODEX_HOME'] || join(home, '.codex')))
  return { claudeDirs: [...claude], codexHomes: [...codex], kiroDirs: [kiroDir ?? join(home, '.kiro')] }
}
