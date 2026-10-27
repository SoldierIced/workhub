/**
 * Reads the token spend of every Claude, Codex and Kiro transcript written in the last days, and
 * keeps what it read in a cache (`SpendCache`, persisted by the caller) so the next scan reads
 * only what was appended: append-only JSONL files resume at the byte offset they stopped at with
 * the parser state they had; whole-file formats (Kiro's JSON, compressed Codex rollouts) are read
 * again only when their size or modification time changed. Never throws.
 *
 * A Claude session copied to another account by failover (same `projects/<folder>/<id>.jsonl` in
 * two config folders) is counted once, from its newest copy: the copies share their beginning and
 * the newest one holds everything said so far.
 */
import { open, readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { mergeSpend, pruneSpend, type SpendBuckets } from '@workhub/core'
import { isCompressed, readRollout } from '../transcript-codex/files'
import { claudePending, claudeSpendLine, codexSpendLine, emptyCosts, kiroSpendFile, type ClaudeSpendState, type CodexSpendState, type CostBuckets } from './parsers'

// 2: entries also keep what the spend cost (`costs`), so older caches are read again.
export const SPEND_CACHE_VERSION = 2

export interface SpendFileEntry {
  size: number
  mtimeMs: number
  /** Bytes read so far (whole lines only); 0 for whole-file formats. */
  offset: number
  state?: ClaudeSpendState | CodexSpendState
  buckets: SpendBuckets
  /** What the committed spend cost at list prices (see `CostBuckets`). */
  costs?: CostBuckets
}

export interface SpendCache {
  version: number
  files: Record<string, SpendFileEntry>
}

export const emptySpendCache = (): SpendCache => ({ version: SPEND_CACHE_VERSION, files: {} })

export interface SpendSources {
  /** Claude config folders (`~/.claude`, each account's): transcripts are under `projects/`. */
  claudeDirs: readonly string[]
  /** Codex homes (`~/.codex`, each account's `CODEX_HOME`): rollouts are under `sessions/`. */
  codexHomes: readonly string[]
  /** Kiro data folders (`~/.kiro`): ACP sessions are `sessions/cli/*.json`. */
  kiroDirs: readonly string[]
}

type Kind = 'claude' | 'codex' | 'codex-zst' | 'kiro'

const CHUNK = 1024 * 1024
const NEWLINE = 0x0a

const names = async (dir: string): Promise<string[]> => readdir(dir).catch(() => [] as string[])
const tick = () => new Promise<void>((r) => setImmediate(r))

/**
 * Feeds the complete lines from `offset` on to `onLine`, a chunk at a time; returns the offset
 * after the last complete line (an unfinished last line is read again next time).
 */
async function readLinesFrom(path: string, offset: number, size: number, onLine: (line: string) => void): Promise<number> {
  const handle = await open(path, 'r').catch(() => null)
  if (!handle) return offset
  try {
    let pos = offset
    let carry = Buffer.alloc(0)
    let consumed = offset
    while (pos < size) {
      const buffer = Buffer.alloc(Math.min(CHUNK, size - pos))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, pos)
      if (bytesRead <= 0) break
      pos += bytesRead
      const data = carry.length ? Buffer.concat([carry, buffer.subarray(0, bytesRead)]) : buffer.subarray(0, bytesRead)
      let start = 0
      for (let i = data.indexOf(NEWLINE); i >= 0; i = data.indexOf(NEWLINE, start)) {
        const line = data.toString('utf8', start, i)
        if (line.trim()) onLine(line)
        start = i + 1
      }
      consumed += start
      carry = Buffer.from(data.subarray(start))
      await tick()
    }
    return consumed
  } finally {
    await handle.close()
  }
}

export class TokenSpendScanner {
  private cache: SpendCache
  private running: Promise<SpendBuckets> | null = null

  constructor(cache: SpendCache | null = null) {
    this.cache = cache && cache.version === SPEND_CACHE_VERSION && cache.files ? cache : emptySpendCache()
  }

  /** The cache as it stands, to persist. */
  snapshot(): SpendCache {
    return this.cache
  }

  /** Buckets from the cache alone, without reading any file (what the last scan found). */
  cached(sinceDay: string): SpendBuckets {
    return this.total(sinceDay)
  }

  /**
   * Scans the files written at or after `since` (epoch ms) and returns the spend of the days from
   * `sinceDay` on. A scan already running is shared.
   */
  scan(sources: SpendSources, since: number, sinceDay: string): Promise<SpendBuckets> {
    this.running ??= this.run(sources, since, sinceDay).finally(() => {
      this.running = null
    })
    return this.running
  }

  private async run(sources: SpendSources, since: number, sinceDay: string): Promise<SpendBuckets> {
    const files = new Map<string, Kind>()
    // One Claude transcript per path relative to its config folder: the newest copy.
    const claude = new Map<string, { path: string; mtimeMs: number }>()
    for (const dir of new Set(sources.claudeDirs)) {
      for (const f of await claudeFiles(dir)) {
        const info = await stat(f).catch(() => null)
        if (!info?.isFile()) continue
        const rel = relative(dir, f)
        const prev = claude.get(rel)
        if (!prev || info.mtimeMs > prev.mtimeMs) claude.set(rel, { path: f, mtimeMs: info.mtimeMs })
      }
    }
    for (const { path } of claude.values()) files.set(path, 'claude')
    for (const home of new Set(sources.codexHomes)) for (const f of await codexFiles(join(home, 'sessions'), since)) files.set(f, isCompressed(f) ? 'codex-zst' : 'codex')
    for (const dir of new Set(sources.kiroDirs)) {
      const cli = join(dir, 'sessions', 'cli')
      for (const n of await names(cli)) if (n.endsWith('.json')) files.set(join(cli, n), 'kiro')
    }
    const next: Record<string, SpendFileEntry> = {}
    for (const [path, kind] of files) {
      const info = await stat(path).catch(() => null)
      if (!info?.isFile() || info.mtimeMs < since) continue
      const entry = await this.read(path, kind, info.size, info.mtimeMs, this.cache.files[path])
      entry.buckets = pruneSpend(entry.buckets, sinceDay)
      if (entry.costs) entry.costs = { usd: pruneSpend(entry.costs.usd, sinceDay), unpriced: pruneSpend(entry.costs.unpriced, sinceDay) }
      next[path] = entry
    }
    this.cache = { version: SPEND_CACHE_VERSION, files: next }
    return this.total(sinceDay)
  }

  private async read(path: string, kind: Kind, size: number, mtimeMs: number, prev: SpendFileEntry | undefined): Promise<SpendFileEntry> {
    if (prev && prev.size === size && prev.mtimeMs === mtimeMs) return prev
    if (kind === 'kiro' || kind === 'codex-zst') {
      const buckets: SpendBuckets = {}
      if (kind === 'kiro') {
        const handle = await open(path, 'r').catch(() => null)
        const text = handle ? await handle.readFile('utf8').catch(() => '').finally(() => handle.close()) : ''
        kiroSpendFile(text, buckets)
      } else {
        const state: CodexSpendState = {}
        const costs = emptyCosts()
        for (const line of (await readRollout(path)).split('\n')) if (line.trim()) codexSpendLine(line, state, buckets, costs)
        await tick()
        return { size, mtimeMs, offset: 0, state, buckets, costs }
      }
      await tick()
      return { size, mtimeMs, offset: 0, buckets }
    }
    // An append-only file resumes; one that shrank was rewritten and is read from the start.
    const resume = prev && prev.offset <= size && prev.size <= size
    const buckets: SpendBuckets = resume ? { ...prev.buckets } : {}
    const costs: CostBuckets = resume && prev.costs ? structuredClone(prev.costs) : emptyCosts()
    const state = resume ? structuredClone(prev.state ?? {}) : {}
    const offset = await readLinesFrom(path, resume ? prev.offset : 0, size, (line) =>
      kind === 'claude' ? claudeSpendLine(line, state as ClaudeSpendState, buckets, undefined, costs) : codexSpendLine(line, state as CodexSpendState, buckets, costs)
    )
    return { size, mtimeMs, offset, state, buckets, costs }
  }

  /**
   * The cost (and tokens) of the files `include` picks over the days from `sinceDay` on: the
   * scanned files billed by API key, chosen by the caller. The pending Claude message counts.
   */
  costs(sinceDay: string, include: (path: string, entry: SpendFileEntry) => boolean): { usd: SpendBuckets; unpriced: SpendBuckets; tokens: SpendBuckets } {
    const out = { usd: {} as SpendBuckets, unpriced: {} as SpendBuckets, tokens: {} as SpendBuckets }
    for (const [path, entry] of Object.entries(this.cache.files)) {
      if (!entry.costs || !include(path, entry)) continue
      mergeSpend(out.usd, pruneSpend(entry.costs.usd, sinceDay))
      mergeSpend(out.unpriced, pruneSpend(entry.costs.unpriced, sinceDay))
      mergeSpend(out.tokens, pruneSpend(entry.buckets, sinceDay))
      const state = entry.state as ClaudeSpendState | undefined
      if (state?.pending) {
        const pending = emptyCosts()
        mergeSpend(out.tokens, pruneSpend(claudePending(state, pending), sinceDay))
        mergeSpend(out.usd, pruneSpend(pending.usd, sinceDay))
        mergeSpend(out.unpriced, pruneSpend(pending.unpriced, sinceDay))
      }
    }
    return out
  }

  private total(sinceDay: string): SpendBuckets {
    const out: SpendBuckets = {}
    for (const entry of Object.values(this.cache.files)) {
      mergeSpend(out, pruneSpend(entry.buckets, sinceDay))
      const state = entry.state as ClaudeSpendState | undefined
      if (state?.pending) mergeSpend(out, pruneSpend(claudePending(state), sinceDay))
    }
    return out
  }
}

/** `projects/<folder>/<session>.jsonl` and the subagent transcripts in `<session>/subagents/`. */
async function claudeFiles(configDir: string): Promise<string[]> {
  const projects = join(configDir, 'projects')
  const out: string[] = []
  for (const folder of await names(projects)) {
    const dir = join(projects, folder)
    for (const name of await names(dir)) {
      if (name.endsWith('.jsonl')) out.push(join(dir, name))
      else if (!name.includes('.')) for (const sub of await names(join(dir, name, 'subagents'))) if (sub.endsWith('.jsonl')) out.push(join(dir, name, 'subagents', sub))
    }
  }
  return out
}

/** Rollouts under `sessions/YYYY/MM/DD/`, skipping days more than 30 days before `since`. */
async function codexFiles(sessionsDir: string, since: number): Promise<string[]> {
  const cutoff = new Date(since - 30 * 86_400_000)
  const limit = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}-${String(cutoff.getDate()).padStart(2, '0')}`
  const numeric = (n: string) => /^\d+$/.test(n)
  const out: string[] = []
  for (const year of (await names(sessionsDir)).filter(numeric)) {
    if (year < limit.slice(0, 4)) continue
    for (const month of (await names(join(sessionsDir, year))).filter(numeric)) {
      if (`${year}-${month}` < limit.slice(0, 7)) continue
      for (const day of (await names(join(sessionsDir, year, month))).filter(numeric)) {
        if (`${year}-${month}-${day}` < limit) continue
        const dir = join(sessionsDir, year, month, day)
        for (const name of await names(dir)) if (name.startsWith('rollout-') && /\.jsonl(\.zst)?$/.test(name)) out.push(join(dir, name))
      }
    }
  }
  return out
}
