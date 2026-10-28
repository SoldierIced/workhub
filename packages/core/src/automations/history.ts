import { expandHomePath } from '../domain/profile-folders'
import type { HistoryEntry } from '../ports'
import { matchesHistory } from '../usecases/history'
import type { AutomationDefinition } from './types'

/** A past session History lists, with the automation it ran for when it is one. */
export type AutomationHistoryEntry = HistoryEntry & { automationId?: string; automationName?: string }

/** One automation's past sessions in History: one row that expands to them. */
export interface AutomationHistoryGroup<T extends AutomationHistoryEntry = AutomationHistoryEntry> {
  automationId: string
  /** The automation's name, else its prompt. */
  name: string
  /** Newest first. */
  entries: T[]
  /** Newest `lastModified` of the group, for ordering. */
  lastModified: number
}

const oneLine = (text: string) => text.trim().replace(/\s+/g, ' ')
const trimSlash = (path: string) => path.replace(/[\\/]+$/, '')

/**
 * Whether a session's first prompt is the automation's prompt. Claude's listing keeps only the
 * name of a slash command (`/slack-pr-review`, its arguments dropped), so that counts too.
 */
function promptMatches(firstPrompt: string | undefined, prompt: string): boolean {
  const first = oneLine(firstPrompt ?? '')
  const wanted = oneLine(prompt)
  if (!first || !wanted) return false
  return first === wanted || (wanted.startsWith('/') && first === wanted.split(' ')[0])
}

/**
 * The automation a past session ran for. Sessions Workhub started for one are linked by identity
 * (`links`: the automations' `owned` record). An older session, from before that record, counts
 * when its first prompt is the automation's prompt and it ran with the same agent in the
 * automation's folder.
 */
export function automationOfHistory(
  entry: HistoryEntry,
  automations: readonly AutomationDefinition[],
  links: Readonly<Record<string, string>>,
  home?: string
): AutomationDefinition | undefined {
  const linked = links[entry.agentSessionId]
  if (linked) {
    const a = automations.find((x) => x.id === linked)
    if (a) return a
  }
  return automations.find((a) => {
    const agentId = a.agentKey.split(':')[0]
    if (agentId !== entry.agentId || !promptMatches(entry.firstPrompt, a.prompt)) return false
    const folder = expandHomePath(a.folder || '~', home)
    // A folder still starting with `~` (no home known) cannot be compared: the prompt decides.
    return !entry.cwd || folder.startsWith('~') || trimSlash(entry.cwd) === trimSlash(folder)
  })
}

/** Marks each entry with the automation it ran for (see `automationOfHistory`). */
export function linkAutomationHistory<T extends HistoryEntry>(
  entries: readonly T[],
  automations: readonly AutomationDefinition[],
  links: Readonly<Record<string, string>>,
  home?: string
): (T & { automationId?: string; automationName?: string })[] {
  if (!automations.length) return [...entries]
  return entries.map((e) => {
    const a = automationOfHistory(e, automations, links, home)
    return a ? { ...e, automationId: a.id, automationName: a.name.trim() || oneLine(a.prompt) } : e
  })
}

/**
 * History's automation rows: the entries that match the search and ran for an automation, one
 * group per automation, newest group first and newest session first inside each; `rest` keeps
 * every other entry for the usual folder groups. The same session listed by two accounts is kept
 * once, the most recent copy.
 */
export function groupAutomationHistory<T extends AutomationHistoryEntry>(entries: readonly T[], query = ''): { groups: AutomationHistoryGroup<T>[]; rest: T[] } {
  const unique = new Map<string, T>()
  const rest: T[] = []
  for (const e of entries) {
    if (!e.automationId) {
      rest.push(e)
      continue
    }
    const key = `${e.agentId}\u0000${e.agentSessionId}`
    const prev = unique.get(key)
    if (!prev || e.lastModified > prev.lastModified) unique.set(key, e)
  }
  const groups = new Map<string, AutomationHistoryGroup<T>>()
  for (const e of unique.values()) {
    // The automation's name is searchable too.
    if (!matchesHistory({ ...e, title: `${e.title}\n${e.automationName ?? ''}` }, query)) continue
    const group = groups.get(e.automationId!)
    if (group) group.entries.push(e)
    else groups.set(e.automationId!, { automationId: e.automationId!, name: e.automationName ?? '', entries: [e], lastModified: 0 })
  }
  return {
    groups: [...groups.values()]
      .map((g) => {
        g.entries.sort((a, b) => b.lastModified - a.lastModified)
        return { ...g, lastModified: g.entries[0]?.lastModified ?? 0 }
      })
      .sort((a, b) => b.lastModified - a.lastModified),
    rest
  }
}
