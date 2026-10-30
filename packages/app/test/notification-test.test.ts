import { describe, expect, it, vi } from 'vitest'
import { testNotification, type TestableNotification } from '../src/main/notification-test'

function fake(outcome: 'show' | 'failed' | 'silent') {
  const listeners: Record<string, ((...a: unknown[]) => void)[]> = {}
  const n = {
    once(event: string, listener: (...a: unknown[]) => void) {
      ;(listeners[event] ??= []).push(listener)
      return n
    },
    on(event: string, listener: (...a: unknown[]) => void) {
      ;(listeners[event] ??= []).push(listener)
      return n
    },
    emit(event: string, ...a: unknown[]) {
      for (const l of listeners[event] ?? []) l(...a)
    },
    show() {
      if (outcome === 'show') n.emit('show')
      if (outcome === 'failed') n.emit('failed', {}, 'not allowed')
    }
  }
  return n as TestableNotification & { emit(event: string, ...a: unknown[]): void }
}

describe('testNotification', () => {
  it('reports a shown notification, and a click brings the app back', async () => {
    const n = fake('show')
    const onClick = vi.fn()
    expect(await testNotification(() => n, onClick)).toEqual({ outcome: 'shown' })
    n.emit('click')
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('reports a refusal with its reason, and a creation error', async () => {
    expect(await testNotification(() => fake('failed'), () => {})).toEqual({ outcome: 'failed', error: 'not allowed' })
    expect(await testNotification(() => { throw new Error('no notifications') }, () => {})).toEqual({ outcome: 'failed', error: 'no notifications' })
  })

  it('gives up when the OS says nothing', async () => {
    expect(await testNotification(() => fake('silent'), () => {}, 5)).toEqual({ outcome: 'timeout' })
  })
})
