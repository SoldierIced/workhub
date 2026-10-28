import { describe, expect, it } from 'vitest'
import { translate } from '../src/renderer/i18n/translate'
import { usageWindowName, usageWindowNameInline } from '../src/renderer/lib/usage-window'

describe('usage window names', () => {
  const t = (key: string) => `t:${key}`
  it('translates the known windows and names a model week by its model', () => {
    expect(usageWindowName('weekly', t)).toBe('t:tray.window.weekly')
    expect(usageWindowName('monthly', t)).toBe('t:tray.window.monthly')
    expect(usageWindowName('weekly Sonnet', t)).toBe('Sonnet')
    expect(usageWindowName('daily', t)).toBe('daily')
  })

  it('uses the mid-sentence casing for plan windows and leaves model names alone', () => {
    expect(usageWindowNameInline('weekly', t)).toBe('t:tray.windowInline.weekly')
    expect(usageWindowNameInline('5h', t)).toBe('t:tray.windowInline.5h')
    expect(usageWindowNameInline('weekly Sonnet', t)).toBe('Sonnet')
    expect(usageWindowNameInline('daily', t)).toBe('daily')
  })

  it('lowercases the Spanish plan windows after the colon', () => {
    expect(translate('es', 'tray.windowInline.weekly')).toBe('semanal')
    expect(translate('es', 'tray.windowInline.monthly')).toBe('mensual')
    expect(translate('en', 'tray.windowInline.weekly')).toBe('Weekly')
  })
})
