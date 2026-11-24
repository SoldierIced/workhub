import { z } from 'zod'

/**
 * What changed in each version, written for the people who use the app, in English and Spanish:
 * `release-notes.json` at the repository root, attached to every release under the same name. The
 * update prompt shows the versions between the running one and the one found, so someone can decide
 * whether to update (CONTRIBUTING.md, Releases, says how an entry is written).
 */
export const RELEASE_NOTES_FILE = 'release-notes.json'

export const RELEASE_NOTES_LIMITS = {
  /** Characters of an item's title and of its optional sentence. */
  title: 80,
  body: 240,
  /** Items of one release. */
  items: 8,
  /** Releases kept in the file; older ones are deleted (CHANGELOG.md has the history). */
  releases: 30,
  /** Versions the app shows at once to someone far behind. */
  shown: 10,
  /** The most the app reads from a release's file. */
  bytes: 256 * 1024
} as const

export const RELEASE_NOTE_KINDS = ['new', 'improved', 'fixed'] as const
export type ReleaseNoteKind = (typeof RELEASE_NOTE_KINDS)[number]

/** The same text in every interface language. */
export interface LocalizedText {
  en: string
  es: string
}

export interface ReleaseNoteItem {
  kind: ReleaseNoteKind
  title: LocalizedText
  /** One sentence on what it is for. */
  body?: LocalizedText
}

export interface ReleaseNotesEntry {
  /** Without the `v` of the tag: `2.0.0-alpha.45`. */
  version: string
  /** The day it was released, `YYYY-MM-DD`. */
  date: string
  items: ReleaseNoteItem[]
}

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

const localized = (max: number) => z.object({ en: z.string().trim().min(1).max(max), es: z.string().trim().min(1).max(max) })
const itemSchema = z.object({ kind: z.enum(RELEASE_NOTE_KINDS), title: localized(RELEASE_NOTES_LIMITS.title), body: localized(RELEASE_NOTES_LIMITS.body).optional() })
const entrySchema = z.object({ version: z.string().regex(VERSION), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), items: z.array(z.unknown()) })

/**
 * Reads the file as a release serves it. It comes from the network, so nothing in it is trusted:
 * an item or a release that does not fit the format is left out, never shown half-read, and the
 * limits bound what reaches the screen.
 */
export function parseReleaseNotes(raw: unknown): ReleaseNotesEntry[] {
  const releases = raw && typeof raw === 'object' ? (raw as { releases?: unknown }).releases : undefined
  if (!Array.isArray(releases)) return []
  const entries: ReleaseNotesEntry[] = []
  for (const release of releases) {
    if (entries.length >= RELEASE_NOTES_LIMITS.releases) break
    const entry = entrySchema.safeParse(release)
    if (!entry.success) continue
    const items: ReleaseNoteItem[] = []
    for (const candidate of entry.data.items) {
      if (items.length >= RELEASE_NOTES_LIMITS.items) break
      const item = itemSchema.safeParse(candidate)
      if (item.success) items.push({ kind: item.data.kind, title: item.data.title, ...(item.data.body ? { body: item.data.body } : {}) })
    }
    if (items.length) entries.push({ version: entry.data.version, date: entry.data.date, items })
  }
  return entries
}

/** One dot-separated part of a pre-release: numbers rank below words and compare as numbers. */
function comparePart(a: string, b: string): number {
  const numeric = /^\d+$/
  if (numeric.test(a) && numeric.test(b)) return Number(a) - Number(b)
  if (numeric.test(a)) return -1
  if (numeric.test(b)) return 1
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Semver precedence of two versions (a leading `v` is ignored): negative when `a` is older, positive
 * when newer, 0 when equal. A pre-release ranks below its version (`2.0.0-alpha.9` < `2.0.0-beta.1`
 * < `2.0.0`). Undefined when either is not a version, so a caller never ranks something it cannot read.
 */
export function compareVersions(a: string, b: string): number | undefined {
  const pa = VERSION.exec(a.trim().replace(/^v/, ''))
  const pb = VERSION.exec(b.trim().replace(/^v/, ''))
  if (!pa || !pb) return undefined
  for (const i of [1, 2, 3]) {
    const diff = Number(pa[i]) - Number(pb[i])
    if (diff !== 0) return diff
  }
  const preA = pa[4]?.split('.') ?? []
  const preB = pb[4]?.split('.') ?? []
  if (!preA.length || !preB.length) return preB.length - preA.length
  for (let i = 0; i < Math.max(preA.length, preB.length); i++) {
    const x = preA[i]
    const y = preB[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const diff = comparePart(x, y)
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * The notes someone on `current` has not seen once they install `target`: every version after
 * theirs up to that one, newest first, the newest `RELEASE_NOTES_LIMITS.shown` at most.
 */
export function notesBetween(entries: readonly ReleaseNotesEntry[], current: string, target: string): ReleaseNotesEntry[] {
  return entries
    .filter((e) => {
      const sinceCurrent = compareVersions(e.version, current)
      const untilTarget = compareVersions(e.version, target)
      return sinceCurrent !== undefined && untilTarget !== undefined && sinceCurrent > 0 && untilTarget <= 0
    })
    .sort((a, b) => compareVersions(b.version, a.version) ?? 0)
    .slice(0, RELEASE_NOTES_LIMITS.shown)
}
