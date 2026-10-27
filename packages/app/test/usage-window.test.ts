import { describe, expect, it } from 'vitest'
import { usageWindowName } from '../src/renderer/lib/usage-window'

describe('usage window names', () => {
  const t = (key: string) => `t:${key}`
  it('translates the known windows and names a model week by its model', () => {
    expect(usageWindowName('weekly', t)).toBe('t:tray.window.weekly')
    expect(usageWindowName('monthly', t)).toBe('t:tray.window.monthly')
    expect(usageWindowName('weekly Sonnet', t)).toBe('Sonnet')
    expect(usageWindowName('daily', t)).toBe('daily')
  })
})
