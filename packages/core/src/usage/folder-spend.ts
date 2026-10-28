/**
 * Token spend per folder of a profile, from the token buckets the transcript scanners keep
 * (Workhub 1's "Claude by folder" card, extended to Codex and Kiro). Pure: the caller reads the
 * transcripts and the folders.
 *
 * A bucket is the fresh tokens (input + cache write + output; cache reads are left out, as in
 * Workhub 1) one agent spent on one local day while working in one path.
 */
import { isThrowawayFolder } from '../usecases/history'
import { localDayKey, startOfLocalDay } from './credits'

export type SpendAgent = 'claude' | 'codex' | 'kiro'
export const SPEND_AGENTS: readonly SpendAgent[] = ['claude', 'codex', 'kiro']

/** Tokens per bucket key (see `spendKey`). */
export type SpendBuckets = Record<string, number>

/** The days the Home card covers, today included. */
export const SPEND_DAYS = 7

const SEP = '\t'

/** The bucket of a day, an agent and the path the agent worked in. */
export function spendKey(day: string, agent: SpendAgent, path: string): string {
  return `${day}${SEP}${agent}${SEP}${path}`
}

export function parseSpendKey(key: string): { day: string; agent: SpendAgent; path: string } | null {
  const first = key.indexOf(SEP)
  const second = key.indexOf(SEP, first + 1)
  if (first < 0 || second < 0) return null
  const agent = key.slice(first + 1, second)
  if (!(SPEND_AGENTS as readonly string[]).includes(agent)) return null
  return { day: key.slice(0, first), agent: agent as SpendAgent, path: key.slice(second + 1) }
}

/** Adds tokens to a bucket; nothing for a missing time or a non-positive amount. */
export function addSpend(buckets: SpendBuckets, at: number | undefined, agent: SpendAgent, path: string | undefined, tokens: number): void {
  if (at === undefined || !Number.isFinite(at) || !path || !Number.isFinite(tokens) || tokens <= 0) return
  const key = spendKey(localDayKey(new Date(at)), agent, path)
  buckets[key] = (buckets[key] ?? 0) + tokens
}

/** Sums bucket sets into `into`. */
export function mergeSpend(into: SpendBuckets, ...sets: readonly SpendBuckets[]): SpendBuckets {
  for (const set of sets) for (const [k, v] of Object.entries(set)) into[k] = (into[k] ?? 0) + v
  return into
}

/** The first day (`YYYY-MM-DD`) of the window that ends today. */
export function spendWindowStart(now: number, days = SPEND_DAYS): string {
  return localDayKey(new Date(startOfLocalDay(now, days - 1)))
}

/** Drops buckets older than `sinceDay` (keys start with the day, so a string compare is enough). */
export function pruneSpend(buckets: SpendBuckets, sinceDay: string): SpendBuckets {
  const out: SpendBuckets = {}
  for (const [k, v] of Object.entries(buckets)) if (k.slice(0, 10) >= sinceDay) out[k] = v
  return out
}

export interface FolderSpendEntry {
  /** What the card shows: a child folder's name, or the profile folder's own name. */
  name: string
  path: string
  /** True for work at the top of a folder that is split into child folders ("acme (root)"). */
  root: boolean
  tokens: number
  byAgent: Partial<Record<SpendAgent, number>>
}

const norm = (p: string) => p.replaceAll('\\', '/').replace(/\/+$/, '')
const lastSegment = (p: string) => norm(p).split('/').filter(Boolean).pop() ?? p

/**
 * Where a path's work counts for a profile, or null when it is outside every profile folder.
 * The deepest profile folder that holds the path wins. A folder listed in `children` (a container
 * of repositories, like Workhub 1's profile roots) is split by its child folders: work in
 * `<folder>/<child>/…` goes to the child, and `_worktrees/<child>-<branch>` to the longest child
 * name it starts with. A sibling `<child>-<branch>` that is not a child itself (a worktree next to
 * its repository, usually removed once merged, so git can no longer say whose it was) goes to the
 * longest child it extends with a dash. Anything else in it (hidden folders, files, made-up paths)
 * goes to the folder itself, marked `root`. A folder without children is one entry.
 */
export function attributeFolder(
  path: string,
  folders: readonly string[],
  children: Readonly<Record<string, readonly string[]>> = {}
): { name: string; path: string; root: boolean } | null {
  const target = norm(path)
  let best: string | undefined
  for (const f of folders) {
    const folder = norm(f)
    if (!folder) continue
    if ((target === folder || target.startsWith(`${folder}/`)) && (!best || folder.length > norm(best).length)) best = f
  }
  if (best === undefined) return null
  const folder = norm(best)
  const kids = children[best] ?? children[folder]
  if (!kids?.length) return { name: lastSegment(folder), path: folder, root: false }
  const rest = target.slice(folder.length + 1).split('/').filter(Boolean)
  let child = rest[0]
  if (child === '_worktrees' && rest[1]) {
    const worktree = rest[1]
    child = kids.filter((k) => worktree.startsWith(k)).sort((a, b) => b.length - a.length)[0]
  } else if (child && !kids.includes(child)) {
    const sibling = child
    child = kids.filter((k) => sibling.startsWith(`${k}-`)).sort((a, b) => b.length - a.length)[0] ?? child
  }
  if (child && !child.startsWith('.') && kids.includes(child)) return { name: child, path: `${folder}/${child}`, root: false }
  return { name: lastSegment(folder), path: folder, root: true }
}

/**
 * A path inside a git worktree that lives elsewhere, moved to the same place in its main
 * repository (`aliases`: worktree root -> main worktree root, the deepest root wins); the path
 * itself when no alias covers it.
 */
export function aliasPath(path: string, aliases: Readonly<Record<string, string>>): string {
  const target = norm(path)
  let best: string | undefined
  for (const root of Object.keys(aliases)) {
    const r = norm(root)
    if (r && (target === r || target.startsWith(`${r}/`)) && (!best || r.length > norm(best).length)) best = root
  }
  return best === undefined ? path : `${norm(aliases[best]!)}${target.slice(norm(best).length)}`
}

/**
 * Tokens per folder of a profile over the days from `sinceDay` on, largest first. Work outside
 * the profile's folders is left out, so each profile shows only its own spend.
 *
 * `aliases` (see `aliasPath`) first moves work in a linked git worktree (outside the folders, or
 * next to its repository inside them) to the same place in its main repository, so it counts there.
 *
 * Two entries with the same folder name (a repository and a copy of it elsewhere) are told apart
 * by their parent folder: `opt/shop`.
 *
 * `owns` (see `owningProfile`) narrows that to the work the profile owns: a deeper folder of another
 * profile is left out, and work it owns outside its folders (the profile that "also owns everything
 * outside") counts under that work's own folder. Throwaway folders never count there. Ownership is
 * judged on the moved path, so an outside worktree counts only for its repository's profile.
 */
export function folderSpend(
  buckets: SpendBuckets,
  folders: readonly string[],
  options: {
    sinceDay: string
    children?: Readonly<Record<string, readonly string[]>>
    owns?: (path: string) => boolean
    aliases?: Readonly<Record<string, string>>
  }
): FolderSpendEntry[] {
  const byPath = new Map<string, FolderSpendEntry>()
  const placeOf = new Map<string, ReturnType<typeof attributeFolder>>()
  const { owns } = options
  for (const [key, tokens] of Object.entries(buckets)) {
    const parsed = parseSpendKey(key)
    if (!parsed || parsed.day < options.sinceDay || !(tokens > 0)) continue
    let place = placeOf.get(parsed.path)
    if (place === undefined) {
      let path = parsed.path
      if (options.aliases) path = aliasPath(path, options.aliases)
      place = owns && !owns(path) ? null : attributeFolder(path, folders, options.children)
      // A removed worktree named after a live one (`shop-fix-2` next to the worktree `shop-fix`)
      // lands on that worktree: follow it to its repository too.
      if (place && !place.root && options.aliases) {
        const moved = aliasPath(place.path, options.aliases)
        if (moved !== place.path) place = attributeFolder(moved, folders, options.children) ?? place
      }
      if (!place && owns && owns(path) && !isThrowawayFolder(path)) place = { name: lastSegment(path), path: norm(path), root: false }
      placeOf.set(parsed.path, place)
    }
    if (!place) continue
    const id = `${place.root ? 'root' : 'dir'}:${place.path}`
    let entry = byPath.get(id)
    if (!entry) {
      entry = { ...place, tokens: 0, byAgent: {} }
      byPath.set(id, entry)
    }
    entry.tokens += tokens
    entry.byAgent[parsed.agent] = (entry.byAgent[parsed.agent] ?? 0) + tokens
  }
  const entries = [...byPath.values()]
  distinguishNames(entries)
  return entries.sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name))
}

/**
 * Entries that share a name get as many parent folders as it takes to tell them apart:
 * `/opt/shop` and `/w/p/shop` become `opt/shop` and `p/shop`.
 */
function distinguishNames(entries: FolderSpendEntry[]): void {
  const groups = new Map<string, FolderSpendEntry[]>()
  for (const e of entries) groups.set(e.name, [...(groups.get(e.name) ?? []), e])
  for (const group of groups.values()) {
    if (group.length < 2) continue
    const parts = group.map((e) => norm(e.path).split('/').filter(Boolean))
    const longest = Math.max(...parts.map((p) => p.length))
    for (let depth = 2; depth <= longest; depth++) {
      const names = parts.map((p) => p.slice(-depth).join('/'))
      if (new Set(names).size === names.length || depth === longest) {
        group.forEach((e, i) => (e.name = names[i]!))
        break
      }
    }
  }
}
