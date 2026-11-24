import { PROMPT_IDS, promptDefinition, promptIssues, promptSavable, withPromptOverride, type PromptDefinition, type PromptId, type PromptIssues, type PromptOverrides } from '@workhub/core'
import { DICTIONARIES, type Locale, type MessageKey } from '../i18n/translate'

/**
 * The default Settings → Prompts shows for a prompt in the UI language: the renderer's own text for
 * prompts it drafts, the Spanish table of core for the others that have one, else the English text.
 */
export function shownDefault(id: PromptId, locale: Locale): string {
  const def: PromptDefinition = promptDefinition(id)
  if (def.i18nKey) return DICTIONARIES[locale][def.i18nKey as MessageKey] ?? def.defaultText
  return locale === 'es' && def.defaultEs !== undefined ? def.defaultEs : def.defaultText
}

/** What each prompt's editor shows: the user's text, else the default. */
export function shownTexts(overrides: PromptOverrides | undefined, locale: Locale): Record<PromptId, string> {
  const out: Record<string, string> = {}
  for (const id of PROMPT_IDS) {
    const own = overrides?.[id]
    out[id] = typeof own === 'string' && own.trim() ? own : shownDefault(id, locale)
  }
  return out as Record<PromptId, string>
}

/** The problems of every prompt whose text cannot be saved. */
export function unsavable(texts: Readonly<Record<PromptId, string>>, locale: Locale): { id: PromptId; issues: PromptIssues }[] {
  return PROMPT_IDS.flatMap((id) => {
    const issues = promptIssues(id, texts[id], shownDefault(id, locale))
    return promptSavable(issues, texts[id]) ? [] : [{ id, issues }]
  })
}

/**
 * The overrides to store after the form was edited. Only the prompts whose text changed in the form
 * are touched: one stored text that happens to equal the default of the language shown now stays
 * (its default may be another language's for the profiles that use it). A changed text is stored
 * unless it is the default shown.
 */
export function overridesFor(saved: PromptOverrides | undefined, texts: Readonly<Record<PromptId, string>>, locale: Locale, baseline: Readonly<Record<PromptId, string>> = shownTexts(saved, locale)): Record<string, string> {
  let next: Record<string, string> = { ...saved }
  for (const id of PROMPT_IDS) if (texts[id] !== baseline[id]) next = withPromptOverride(next, id, texts[id], shownDefault(id, locale))
  return next
}
