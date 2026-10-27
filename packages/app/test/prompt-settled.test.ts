import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettleWaits } from '../src/renderer/lib/settle-waits'

afterEach(() => vi.useRealTimers())

const state = (p: Promise<void>) => {
  const s = { done: false }
  void p.then(() => (s.done = true))
  return s
}

describe('SettleWaits', () => {
  it('waits for the notice that follows the turn events', async () => {
    const waits = new SettleWaits()
    const s = state(waits.wait('s:1', 10_000))
    await Promise.resolve()
    expect(s.done).toBe(false)
    waits.notify('s:1')
    await Promise.resolve()
    await Promise.resolve()
    expect(s.done).toBe(true)
  })

  it('keeps a notice that came before the wait', async () => {
    const waits = new SettleWaits()
    waits.notify('s:2')
    await expect(waits.wait('s:2', 10_000)).resolves.toBeUndefined()
  })

  it('ends the wait after the timeout when no notice comes', async () => {
    vi.useFakeTimers()
    const waits = new SettleWaits()
    const s = state(waits.wait('s:3', 500))
    await vi.advanceTimersByTimeAsync(499)
    expect(s.done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(s.done).toBe(true)
  })

  it('does not end another prompt\'s wait', async () => {
    vi.useFakeTimers()
    const waits = new SettleWaits()
    const s = state(waits.wait('s:4', 500))
    waits.notify('s:5')
    await vi.advanceTimersByTimeAsync(10)
    expect(s.done).toBe(false)
  })
})
