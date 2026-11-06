import { EFFORT_LEVELS } from '@workhub/core'
import type { MessageKey } from '../i18n/translate'

/** One choice of a select: the value stored and the text shown. */
export interface ChoiceOption {
  value: string
  label: string
}

/** The select value of the "Other…" choice (never stored: the custom text is). */
export const CUSTOM_OPTION = '__custom__'

export interface OptionOrCustomState {
  /** What the select shows: a known option, `''` for the empty choice, or `CUSTOM_OPTION`. */
  selected: string
  /** Whether the text input for a custom value is shown. */
  custom: boolean
}

/**
 * Maps a stored value onto the select: a known option shows as itself, `''` as the empty choice
 * (when there is one), anything else as "Other…" with the value in the text input, so a value the
 * list does not know is never lost. `forceCustom`: the user picked "Other…" and is typing.
 */
export function optionOrCustomState(value: string, options: readonly Pick<ChoiceOption, 'value'>[], opts: { allowEmpty: boolean; forceCustom?: boolean }): OptionOrCustomState {
  if (opts.forceCustom) return { selected: CUSTOM_OPTION, custom: true }
  if (value === '' && opts.allowEmpty) return { selected: '', custom: false }
  if (value !== '' && options.some((o) => o.value === value)) return { selected: value, custom: false }
  return { selected: CUSTOM_OPTION, custom: true }
}

/**
 * What a pick in the select stores: a known option its value, the empty choice `''`, and
 * "Other…" keeps the current value (the text input starts on it), or `''` when that was empty.
 */
export function valueForPick(picked: string, current: string): string {
  return picked === CUSTOM_OPTION ? current : picked
}

/** The known options of several lists in order, without empty values or duplicates (the first label wins). */
export function mergeOptions(...lists: readonly (readonly ChoiceOption[])[]): ChoiceOption[] {
  const out: ChoiceOption[] = []
  for (const list of lists) for (const o of list) if (o.value && !out.some((x) => x.value === o.value)) out.push(o)
  return out
}

/** Plain ids as options (the label is the id). */
export const idOptions = (ids: readonly string[]): ChoiceOption[] => ids.map((id) => ({ value: id, label: id }))

/**
 * The models a picker suggests: the ones the agent listed, or, for a Claude agent that has not
 * listed any yet, the Claude aliases (a suggestion, never a limit).
 */
export function modelOptions(listed: readonly ChoiceOption[], claude: boolean, claudeSuggestions: readonly string[]): ChoiceOption[] {
  return listed.length ? mergeOptions(listed) : claude ? idOptions(claudeSuggestions) : []
}

/** The reasoning effort levels as choices, lowest first, labelled in the UI language. */
export function effortOptions(t: (key: MessageKey) => string): ChoiceOption[] {
  return EFFORT_LEVELS.map((e) => ({ value: e, label: t(`automations.effort.${e}`) }))
}
