import { describe, expect, it } from 'vitest'
import { ActiveClock } from '../src'

describe('ActiveClock', () => {
  it('sums the time spent busy across turns', () => {
    const c = new ActiveClock()
    c.observe('starting', 0)
    c.observe('ready', 1_000)
    c.observe('busy', 2_000)
    c.observe('ready', 12_000)
    c.observe('busy', 20_000)
    expect(c.isBusy()).toBe(true)
    // An open turn counts up to now.
    expect(c.ms(25_000)).toBe(15_000)
    c.observe('ready', 30_000)
    expect(c.ms(99_000)).toBe(20_000)
  })

  it('ignores a repeated busy and counts a stop or error as the end of the turn', () => {
    const c = new ActiveClock()
    c.observe('busy', 0)
    c.observe('busy', 5_000)
    c.observe('error', 10_000)
    expect(c.ms(50_000)).toBe(10_000)
    expect(c.isBusy()).toBe(false)
  })
})
