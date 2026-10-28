import type { SessionState } from '@workhub/core'
import type { MessageKey } from '../i18n/translate'

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
 * How the session header fits its controls; each level is tighter than the one before, and what
 * does not fit goes to the "More" menu. `full`: everything with its label. `icons`: the model and
 * mode pickers, the review tools, the AI review and "Continue" show their icon only (the name on
 * hover). `compact`: the status chips (permission mode, agent mode) move to the menu. `tight`: the
 * review tools, the AI review and "Continue" move too. `narrow`: the pickers move as well.
 */
export type HeaderDensity = 'full' | 'icons' | 'compact' | 'tight' | 'narrow'

/** The density a header width starts from; `foldDensity` tightens it while the row still overflows. */
export function headerDensity(width: number): HeaderDensity {
  if (width >= 1240) return 'full'
  if (width >= 700) return 'icons'
  return 'narrow'
}

const DENSITIES: readonly HeaderDensity[] = ['full', 'icons', 'compact', 'tight', 'narrow']

/**
 * The density `steps` levels tighter than `base` (never past `narrow`). The header starts from
 * its width's density and folds one more level each time its row still overflows (long labels,
 * an account name, many controls), so nothing is ever drawn over something else.
 */
export function foldDensity(base: HeaderDensity, steps: number): HeaderDensity {
  return DENSITIES[Math.min(DENSITIES.length - 1, DENSITIES.indexOf(base) + Math.max(0, Math.floor(steps)))]!
}

/** Labels the adapters write in English for modes Workhub names itself, by mode id. */
const WORKHUB_MODE_LABELS: Record<string, string> = {
  default: 'Ask before edits',
  acceptEdits: 'Accept edits',
  plan: 'Plan mode',
  bypassPermissions: 'Bypass permissions',
  dontAsk: "Don't ask",
  auto: 'Auto'
}

/**
 * The permission mode's label in the UI language. The adapters word the modes Workhub names
 * itself in English (unknown, set by the agent, Claude's own modes); those are translated here.
 * A mode name the agent reports is shown as it came.
 */
export function permissionModeLabel(
  mode: { id: string; label: string },
  currentModeId: string | undefined,
  t: (key: MessageKey, params?: Record<string, string | number>) => string
): string {
  if (mode.id === 'unknown') return t('session.mode.notReported')
  if (mode.id === 'agent-managed') return currentModeId ? t('session.mode.setByAgentNamed', { name: currentModeId }) : t('session.mode.setByAgent')
  if (WORKHUB_MODE_LABELS[mode.id] === mode.label) return t(`session.mode.${mode.id}` as MessageKey)
  if (mode.label === 'Plan (read-only)') return t('session.mode.planReadOnly')
  return mode.label
}

type Translate = (key: MessageKey, params?: Record<string, string | number>) => string

/**
 * The model a session runs, as shown under its chat: the one picked (by its listed name), else the
 * one the agent reported in its replies, else the agent's default.
 */
export function sessionModelName(
  v: { models?: { id: string; name: string }[]; currentModelId?: string; modelIgnored?: boolean },
  reported: string | undefined,
  t: Translate
): string {
  const picked = v.modelIgnored ? undefined : v.currentModelId
  if (picked) return v.models?.find((m) => m.id === picked)?.name ?? picked
  return reported?.trim() || t('session.modelDefault')
}

/** The permission mode of a session in words, or why it is not known yet. */
export function sessionPermissionName(v: { permissionMode: { id: string; label: string } | null; currentModeId?: string; state: SessionState }, t: Translate): string {
  if (v.permissionMode) return permissionModeLabel(v.permissionMode, v.currentModeId, t)
  return v.state === 'starting' ? t('session.pending') : t('session.unknown')
}
