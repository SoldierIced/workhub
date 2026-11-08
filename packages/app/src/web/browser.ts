// What the phone app needs from the browser: who this device is, where the service worker reads
// the identity seed, and Web Push. Kept apart from the React screens so the client stays testable.
import type { RemoteDevicePlatform } from '../shared/remote-api'

export function detectPlatform(ua: string = navigator.userAgent): RemoteDevicePlatform {
  if (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && 'ontouchend' in document)) return 'ios'
  if (/Android/i.test(ua)) return 'android'
  return 'web'
}

/** A name the desktop shows for this device before the person edits it. */
export function defaultDeviceName(platform: RemoteDevicePlatform, ua: string = navigator.userAgent): string {
  const browser = /CriOS|Chrome/i.test(ua) ? 'Chrome' : /FxiOS|Firefox/i.test(ua) ? 'Firefox' : /Safari/i.test(ua) ? 'Safari' : 'Browser'
  switch (platform) {
    case 'ios':
      return /iPad/i.test(ua) ? `iPad · ${browser}` : `iPhone · ${browser}`
    case 'android':
      return `Android · ${browser}`
    default:
      return browser
  }
}

/** iOS shows web notifications only to apps added to the home screen. */
export function isStandalone(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true
}

export function pushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

export { kvGet, kvSet, SEED_KEY } from './kv'

// ---- Web Push

export interface PushSubscriptionJson {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null
  try {
    return await navigator.serviceWorker.register('/sw.js')
  } catch {
    return null
  }
}

export async function currentPushSubscription(): Promise<PushSubscriptionJson | null> {
  if (!pushSupported()) return null
  const registration = await navigator.serviceWorker.ready
  const sub = await registration.pushManager.getSubscription()
  return sub ? toJson(sub) : null
}

/** Asks for permission and subscribes; null when refused or unsupported. */
export async function subscribeToPush(vapidPublicKey: string): Promise<PushSubscriptionJson | null> {
  if (!pushSupported()) return null
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return null
  const registration = await navigator.serviceWorker.ready
  const sub = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: vapidKeyBytes(vapidPublicKey) })
  return toJson(sub)
}

export async function unsubscribeFromPush(): Promise<void> {
  if (!pushSupported()) return
  const registration = await navigator.serviceWorker.ready
  const sub = await registration.pushManager.getSubscription()
  await sub?.unsubscribe()
}

function toJson(sub: PushSubscription): PushSubscriptionJson | null {
  const json = sub.toJSON()
  if (!json.endpoint || !json.keys?.['p256dh'] || !json.keys?.['auth']) return null
  return { endpoint: json.endpoint, keys: { p256dh: json.keys['p256dh'], auth: json.keys['auth'] } }
}

/** The VAPID public key as the Push API takes it (base64url → bytes). */
export function vapidKeyBytes(key: string): Uint8Array<ArrayBuffer> {
  const padded = key.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (key.length % 4)) % 4)
  const raw = atob(padded)
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes
}
