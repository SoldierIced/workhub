/// <reference lib="webworker" />
// The service worker: opens pushed notifications (sealed to this device's key by the desktop) and
// shows them; a tap opens the app on the session the notification is about. Nothing is cached
// here: the app is small and the relay serves it with its own cache headers.
import { decodeJson, fromBase64Url, identityFromSeed, openBox, parsePushPayload } from '@workhub/protocol'
import { kvGet, SEED_KEY } from './kv'

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
  await self.registration.showNotification(payload.title, {
    body: payload.body,
    icon: '/icons/icon-256.png',
    badge: '/icons/icon-256.png',
    ...(payload.tag ? { tag: payload.tag } : {}),
    data: { route: payload.route ?? '#', ts: payload.ts }
  })
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
