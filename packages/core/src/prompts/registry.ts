import { AGENT_PROMPTS } from './defs/agents'
import { RENDERER_PROMPTS } from './defs/renderer'
import { REVIEW_PROMPTS } from './defs/review'
import { MAX_PROMPT_LENGTH, type PromptDefinition, type PromptOverrides } from './types'

/** Every prompt the user may rewrite in Settings → Prompts, by id. */
export const PROMPTS = { ...REVIEW_PROMPTS, ...AGENT_PROMPTS, ...RENDERER_PROMPTS } satisfies Record<string, PromptDefinition>
export type PromptId = keyof typeof PROMPTS
export const PROMPT_IDS = Object.keys(PROMPTS) as PromptId[]

const DEFS: Readonly<Record<string, PromptDefinition>> = PROMPTS
const PLACEHOLDER = /\{(\w+)\}/g

export const isPromptId = (id: string): id is PromptId => Object.hasOwn(DEFS, id)

/** A prompt's definition. */
export const promptDefinition = (id: PromptId): PromptDefinition => DEFS[id]!

/**
 * The text to send for a prompt: the user's own when they wrote one, else the default (the
 * caller's localized one when the default follows a language).
 */
export function promptTemplate(overrides: PromptOverrides | undefined, id: PromptId, localizedDefault?: string): string {
  const own = overrides?.[id]
  if (typeof own === 'string' && own.trim()) return own
  return localizedDefault ?? DEFS[id]!.defaultText
}

/** Fills `{name}` with `values[name]`; a placeholder without a value stays as written. */
export function fillPrompt(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(PLACEHOLDER, (whole, name: string) => (Object.hasOwn(values, name) ? String(values[name]) : whole))
}

/** The placeholders a text uses, once each, in order. */
export function placeholdersIn(text: string): string[] {
  return [...new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1]!))]
}

export interface PromptIssues {
  /** Placeholders the prompt does not know (a typo such as `{titel}`): saving is refused. */
  unknown: string[]
  /** Slots the text dropped: what Workhub gathered would not reach the agent. Saving is refused. */
  missingSlots: string[]
  /** Other placeholders the default uses and the text dropped: allowed, shown as a warning. */
  missingOptional: string[]
}

/** What is wrong with a text for a prompt, against its definition (and the default shown). */
export function promptIssuesOf(def: PromptDefinition, text: string, shownDefault: string = def.defaultText): PromptIssues {
  const used = placeholdersIn(text)
  const slots = def.slots ?? []
  return {
    unknown: used.filter((p) => !def.placeholders.includes(p)),
    missingSlots: slots.filter((p) => !used.includes(p)),
    missingOptional: placeholdersIn(shownDefault).filter((p) => !slots.includes(p) && def.placeholders.includes(p) && !used.includes(p))
  }
}

export function promptIssues(id: PromptId, text: string, shownDefault?: string): PromptIssues {
  return promptIssuesOf(DEFS[id]!, text, shownDefault)
}

/** Whether a text can be saved: no unknown placeholder, every slot kept, within the length limit. */
export const promptSavable = (issues: PromptIssues, text: string): boolean => issues.unknown.length === 0 && issues.missingSlots.length === 0 && text.length <= MAX_PROMPT_LENGTH

/**
 * The overrides with `id` set to `text`, or without it when the text is blank or the default shown
 * (so saving an untouched text never freezes today's default).
 */
export function withPromptOverride(overrides: PromptOverrides | undefined, id: string, text: string, shownDefault: string): Record<string, string> {
  const next: Record<string, string> = { ...overrides }
  if (!text.trim() || text === shownDefault) delete next[id]
  else next[id] = text
  return next
}

/**
 * The stored overrides as config.json holds them, entry by entry: non-text, blank and over-long
 * entries are left out, so one bad entry never costs the others or keeps the config from loading.
 * A text for an id this version does not know is kept as it is (unused): it may belong to a later
 * or earlier version, and saving Settings must never delete what the user wrote. A version that
 * renames an id moves its text with a config migration.
 */
export function cleanPromptOverrides(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, string> = {}
  for (const [id, text] of Object.entries(raw)) {
    if (id && typeof text === 'string' && text.trim() && text.length <= MAX_PROMPT_LENGTH) out[id] = text
  }
  return Object.keys(out).length ? out : undefined
}
