import type { MessageKey, Params } from '../i18n/translate'

const NAMED: Record<string, MessageKey> = { '5h': 'tray.window.5h', weekly: 'tray.window.weekly', monthly: 'tray.window.monthly' }

/**
 * A plan usage window as people read it: "5h", "Weekly", "Monthly"; a model's own week
 * ("weekly Sonnet") is the model's name alone. Unknown windows keep the agent's own name.
 */
export function usageWindowName(window: string, t: (key: MessageKey, params?: Params) => string): string {
  const key = NAMED[window]
  return key ? t(key) : window.replace(/^weekly /, '')
}

const CEILING: Record<string, MessageKey> = {
  '5h': 'agentUsage.settings.ceiling.5h',
  weekly: 'agentUsage.settings.ceiling.weekly',
  monthly: 'agentUsage.settings.ceiling.monthly'
}

/** The label of a window's usage ceiling field, worded so the window name reads mid-sentence in every language. */
export function usageCeilingLabel(window: string, t: (key: MessageKey, params?: Params) => string): string {
  const key = CEILING[window]
  return key ? t(key) : t('agentUsage.settings.ceiling', { window: usageWindowName(window, t) })
}
