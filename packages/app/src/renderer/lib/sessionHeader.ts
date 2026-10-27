import type { SessionState } from '@workhub/core'

/**
 * The session header's pure parts (Workhub 1's ConsoleStatusBar and ActivityPill): the folder in
 * short, the activity with its timer, and which controls fit on the one row.
 */

/** `/Users/ana/src/acme/web` → `~/src/acme/web`; a long path keeps its last two folders: `~/…/acme/web`. */
export function abbreviateFolder(path: string, maxSegments = 3): string {
  const home = path.replace(/^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)(?=[/\\]|$)/, '~')
  const sep = home.includes('\\') && !home.includes('/') ? '\\' : '/'
  const parts = home.split(sep).filter((p, i) => p !== '' || i === 0)
  // `~`, or '' for an absolute path, then the folders.
  const [head, ...rest] = parts
  if (rest.length <= maxSegments) return home
  return [head, '…', ...rest.slice(-2)].join(sep)
}

export type Activity = 'starting' | 'working' | 'needsYou' | 'idle' | 'stopped' | 'error'

/** What the session is doing, as the header's pill says it. */
export function activityOf(state: SessionState, awaitingAnswer: boolean): Activity {
  if (state === 'busy') return awaitingAnswer ? 'needsYou' : 'working'
  if (state === 'ready') return awaitingAnswer ? 'needsYou' : 'idle'
  return state
}

/** Activities whose timer ticks every second, as a clock ("1:23"); the others count minutes ("2 min"). */
export function isClockActivity(a: Activity): boolean {
  return a === 'working' || a === 'starting' || a === 'needsYou'
}

/** 83 s → "1:23", 3723 s → "1:02:03". */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

/** 40 s → "<1 min", 125 s → "2 min", 2 h 5 min → "2 h 5 min", over a day → "1 d 3 h". */
export function formatSince(ms: number): string {
  const min = Math.floor(Math.max(0, ms) / 60_000)
  if (min < 1) return '<1 min'
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  if (h < 24) return min % 60 ? `${h} h ${min % 60} min` : `${h} h`
  return h % 24 ? `${Math.floor(h / 24)} d ${h % 24} h` : `${Math.floor(h / 24)} d`
}

/** The pill's timer text, counted from when the state began. */
export function activityElapsed(a: Activity, since: number, now: number): string {
  const ms = now - since
  return isClockActivity(a) ? formatClock(ms) : formatSince(ms)
}

/**
 * Which secondary controls stay on the header row at a given header width; the rest go to the
 * "More" menu. `full`: everything inline. `compact`: the status chips (permission mode, agent mode)
 * move to the menu. `narrow`: the pickers, the AI review and "Continue" move too.
 */
export type HeaderDensity = 'full' | 'compact' | 'narrow'

export function headerDensity(width: number): HeaderDensity {
  if (width >= 1240) return 'full'
  if (width >= 1000) return 'compact'
  return 'narrow'
}
