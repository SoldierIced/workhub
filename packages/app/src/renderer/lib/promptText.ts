import { appOptions, fillPrompt, promptTemplate, type PromptId, type PromptOverrides } from '@workhub/core'
import { currentConfig } from '../configStore'
import { translate, type Locale, type MessageKey } from '../i18n/translate'

/**
 * The text of a prompt the screens draft: the user's own (Settings → Prompts), else the dictionary
 * text of the UI language, with `{name}` placeholders filled. Without an override it is exactly
 * what `translate(locale, key, values)` returns.
 */
export function draftPrompt(overrides: PromptOverrides | undefined, id: PromptId, locale: Locale, key: MessageKey, values: Readonly<Record<string, string | number>> = {}): string {
  return fillPrompt(promptTemplate(overrides, id, translate(locale, key)), values)
}

/** The overrides of the config snapshot the screens already hold (undefined before it loads). */
export function currentPromptOverrides(): PromptOverrides | undefined {
  const snap = currentConfig()
  return snap ? appOptions(snap.config).prompts : undefined
}

/** The overrides at this moment, reading the config when no snapshot is at hand (a window of its own). */
export async function loadPromptOverrides(): Promise<PromptOverrides | undefined> {
  try {
    const snap = currentConfig() ?? (await window.hub.config.get())
    return appOptions(snap.config).prompts
  } catch {
    return undefined
  }
}
