import { describe, expect, it } from 'vitest'
import type { NotificationPermission } from '@workhub/adapters/notification-permission'
import { NotificationPermissionCheck, type ProbeNotification } from '../src/main/notification-permission'

type Outcome = 'show' | 'failed' | 'silent'

/** A fake native notification: emits `outcome` when shown. */
function fakeNotification(outcome: Outcome, log: string[]): ProbeNotification & { emit(e: 'show' | 'failed'): void } {
  const listeners: Record<string, ((...a: unknown[]) => void)[]> = {}
  const n = {
    once(event: string, listener: (...a: unknown[]) => void) {
      ;(listeners[event] ??= []).push(listener)
      return n
    },
    emit(event: 'show' | 'failed') {
      for (const l of listeners[event] ?? []) l({}, 'denied')
    },
    show() {
      log.push('show')
      if (outcome !== 'silent') n.emit(outcome)
    },
    close() {
      log.push('close')
    }
  }
  return n as ProbeNotification & { emit(e: 'show' | 'failed'): void }
}

function check(opts: { prefs?: NotificationPermission; probe?: Outcome; platform?: NodeJS.Platform; supported?: boolean; now?: () => number }) {
  const log: string[] = []
  let probes = 0
  const c = new NotificationPermissionCheck({
    platform: opts.platform ?? 'darwin',
    supported: () => opts.supported ?? true,
    readPrefs: async () => opts.prefs ?? 'unknown',
    createProbe: () => {
      probes++
      return fakeNotification(opts.probe ?? 'show', log)
    },
    probeTimeoutMs: 10,
    ...(opts.now ? { now: opts.now } : {})
  })
  return { c, log, probes: () => probes }
}

describe('NotificationPermissionCheck', () => {
  it('trusts the Notification Center preferences when they can be read, without probing', async () => {
    const denied = check({ prefs: 'denied' })
    expect(await denied.c.allowed()).toBe(false)
    expect(await check({ prefs: 'allowed' }).c.allowed()).toBe(true)
    expect(denied.probes()).toBe(0)
  })

  it('is off when the OS has no notifications, and on outside macOS', async () => {
    expect(await check({ supported: false }).c.allowed()).toBe(false)
    const linux = check({ platform: 'linux', probe: 'failed' })
    expect(await linux.c.allowed()).toBe(true)
    expect(linux.probes()).toBe(0)
  })

  it('probes once with a silent notification it closes, and remembers that it was shown', async () => {
    const t = check({ probe: 'show' })
    expect(await t.c.allowed()).toBe(true)
    expect(await t.c.allowed()).toBe(true)
    expect(t.probes()).toBe(1)
    expect(t.log).toEqual(['show', 'close'])
  })

  it('reports a refused probe, and probes again after a while (coming back from System Settings)', async () => {
    let now = 0
    const t = check({ probe: 'failed', now: () => now })
    expect(await t.c.allowed()).toBe(false)
    expect(await t.c.allowed()).toBe(false)
    expect(t.probes()).toBe(1)
    now = 60_000
    expect(await t.c.allowed()).toBe(false)
    expect(t.probes()).toBe(2)
  })

  it('uses what the app\'s own notifications reported, and does not warn when a probe says nothing', async () => {
    const t = check({ probe: 'silent' })
    const log: string[] = []
    const shown = t.c.observe(fakeNotification('failed', log))
    shown.show()
    expect(await t.c.allowed()).toBe(false)
    expect(t.probes()).toBe(0)
    expect(await check({ probe: 'silent' }).c.allowed()).toBe(true)
  })
})
