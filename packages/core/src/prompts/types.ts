/** The screens and features a prompt belongs to; Settings → Prompts groups them this way. */
export type PromptArea = 'review' | 'continuity' | 'listen' | 'chat' | 'sessions' | 'links' | 'health'

export const PROMPT_AREAS: readonly PromptArea[] = ['review', 'continuity', 'listen', 'chat', 'sessions', 'links', 'health']

/**
 * One instruction text Workhub writes to an agent, that the user may rewrite in Settings → Prompts.
 * Only the instruction is editable: what Workhub gathers goes in through `slots`, and the reply
 * formats it parses, the untrusted-data notes and the read-only guards stay in code.
 */
export interface PromptDefinition {
  area: PromptArea
  /** Every `{name}` the text may use (slots included). */
  placeholders: readonly string[]
  /** Placeholders a text must keep: where Workhub puts what it gathered. */
  slots?: readonly string[]
  /** Today's text in English, `{name}` placeholders included. */
  defaultText: string
  /** The Spanish default of a text core keeps in an en/es table (it follows a profile setting). */
  defaultEs?: string
  /** The renderer's i18n key whose raw text is the default in the UI language. */
  i18nKey?: string
}

/** The user's texts by prompt id (Settings → Prompts); a missing id uses its default. */
export type PromptOverrides = Readonly<Record<string, string>>

/** The longest text a prompt may have. */
export const MAX_PROMPT_LENGTH = 20_000
