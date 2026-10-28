import { describe, expect, it } from 'vitest'
import { createQuickSessionGate } from '../src/renderer/lib/quickSessionGate'

describe('quick session gate', () => {
  it('lets the first trigger through and drops a duplicate in the same burst', () => {
    let t = 1000
    const allow = createQuickSessionGate(600, () => t)
    expect(allow()).toBe(true)
    t += 50
    expect(allow()).toBe(false)
  })

  it('allows another session once the window has passed', () => {
    let t = 1000
    const allow = createQuickSessionGate(600, () => t)
    expect(allow()).toBe(true)
    t += 600
    expect(allow()).toBe(true)
  })
})
