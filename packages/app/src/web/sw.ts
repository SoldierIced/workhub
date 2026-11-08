/// <reference lib="webworker" />
// The service worker: opens pushed notifications (sealed to this device's key by the desktop) and
// shows them; a tap opens the app on the session the notification is about. Nothing is cached
// here: the app is small and the relay serves it with its own cache headers.
import { decodeJson, fromBase64Url, identityFromSeed, isPublicIdentity, openBox, parsePushPayload, verifyPushPayload } from '@workhub/protocol'
import { DESKTOPS_KEY, kvGet, SEED_KEY } from './kv'

declare const self: ServiceWorkerGlobalScope

self.addEventListener('install', () => void self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  event.waitUntil(showPushed(event.data?.text() ?? ''))
})

async function showPushed(text: string): Promise<void> {
  let box: { e: string; c: string } | null = null
  try {
    const parsed = JSON.parse(text) as { box?: { e?: unknown; c?: unknown } }
    if (typeof parsed.box?.e === 'string' && typeof parsed.box.c === 'string') box = { e: parsed.box.e, c: parsed.box.c }
  } catch {
    return
  }
  if (!box) return
  const seed = await kvGet(SEED_KEY)
  if (!seed) return
  const identity = identityFromSeed(fromBase64Url(seed))
  const plain = openBox(identity, box)
  if (!plain) return
  let payload: ReturnType<typeof parsePushPayload> = null
  try {
    payload = parsePushPayload(decodeJson(plain))
  } catch {
    return
  }
  if (!payload) return
  // Only a desktop this phone paired with may notify it: the relay holds the phone's public key
  // and could seal a box of its own, but it cannot sign as the desktop.
  if (!(await signedByPairedDesktop(payload))) return
  await self.registration.showNotification(payload.title, {
    body: payload.body,
    icon: '/icons/icon-256.png',
    badge: '/icons/icon-256.png',
    ...(payload.tag ? { tag: payload.tag } : {}),
    data: { route: `#d/${payload.desktop}/${(payload.route ?? '#').replace(/^#\/?/, '')}`, ts: payload.ts }
  })
}

async function signedByPairedDesktop(payload: NonNullable<ReturnType<typeof parsePushPayload>>): Promise<boolean> {
  const raw = await kvGet(DESKTOPS_KEY)
  if (!raw) return false
  let desktops: Record<string, unknown>
  try {
    desktops = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return false
  }
  const pub = desktops[payload.desktop]
  return isPublicIdentity(pub) && verifyPushPayload(payload, pub, Date.now())
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const route = typeof event.notification.data?.route === 'string' ? (event.notification.data.route as string) : '#'
  event.waitUntil(openApp(route))
})

async function openApp(route: string): Promise<void> {
  const url = new URL(`/${route.startsWith('#') ? route : `#${route}`}`, self.location.origin).href
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  const existing = clients[0]
  if (existing) {
    await existing.focus()
    if ('navigate' in existing) await existing.navigate(url)
    return
  }
  await self.clients.openWindow(url)
}
