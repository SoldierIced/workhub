/**
 * Prompt text as an agent transcript stores it. Claude Code wraps a long paste in
 * `<pasted_content id="…">…</pasted_content>` and the harness adds blocks of its own
 * (`<system-reminder>`, `<command-name>`, …). None of that is what the user wrote, so it never
 * belongs in a title or in a replayed message.
 */

/** Blocks the harness injects: dropped with their content. */
const HARNESS_BLOCK = /<(system-reminder|task-notification|command-message|command-name|command-args|local-command-[\w-]+|bash-input|bash-stdout|bash-stderr)(?:\s[^>]*)?>[\s\S]*?(?:<\/\1>|$)/g

/** The paste wrapper (also cut off mid-tag, as a stored first prompt can be): only the tags go, the pasted text stays. */
const PASTE_TAG = /<\/?pasted_content(?:\s[^>]*)?(?:>|$)/g

/** The text a user wrote or pasted, without the wrappers around it; empty when nothing readable is left. */
export function stripPromptWrappers(text: string): string {
  return text.replace(HARNESS_BLOCK, '').replace(PASTE_TAG, '').replace(/\n{3,}/g, '\n\n').trim()
}

/** The most a title keeps of a prompt's line. */
export const PROMPT_TITLE_MAX = 60

/** The first meaningful line of a prompt, wrappers removed, whitespace collapsed and cut to a row's length; undefined when none is left. */
export function promptTitle(text: string | undefined, max = PROMPT_TITLE_MAX): string | undefined {
  if (!text) return undefined
  const line = stripPromptWrappers(text).split('\n').find((l) => l.trim())?.trim().replace(/\s+/g, ' ')
  if (!line) return undefined
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}
