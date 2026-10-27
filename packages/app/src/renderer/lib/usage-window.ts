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
