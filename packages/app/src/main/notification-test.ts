import type { NotificationTestResult } from '../shared/setup-api'

/** The part of Electron's Notification a test needs. */
export interface TestableNotification {
  once(event: 'show', listener: () => void): unknown
  once(event: 'failed', listener: (event: unknown, error: string) => void): unknown
  on(event: 'click' | 'close', listener: () => void): unknown
  show(): void
}

/** Notifications shown by a test, referenced until they close: a collected one disappears from the notification center. */
const live = new Set<TestableNotification>()

/**
 * Settings → Notifications → "Send test": shows one notification through the OS and reports what the
 * OS said: shown, refused (with its reason), or nothing within `timeoutMs`. `onClick` brings the
 * app back when the user clicks it.
 */
export function testNotification(create: () => TestableNotification, onClick: () => void, timeoutMs = 4_000): Promise<NotificationTestResult> {
  return new Promise((resolve) => {
    let notification: TestableNotification
    try {
      notification = create()
    } catch (e) {
      return resolve({ outcome: 'failed', error: e instanceof Error ? e.message : String(e) })
    }
    live.add(notification)
    const done = (result: NotificationTestResult) => {
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => done({ outcome: 'timeout' }), timeoutMs)
    notification.once('show', () => done({ outcome: 'shown' }))
    notification.once('failed', (_e, error) => {
      live.delete(notification)
      done({ outcome: 'failed', error: String(error) })
    })
    notification.on('click', () => {
      live.delete(notification)
      onClick()
    })
    notification.on('close', () => live.delete(notification))
    notification.show()
  })
}
