// The phone app's entry: builds `window.hub` over the encrypted channel to the desktop, so the
// renderer's store and components work unchanged, and mounts the screens.
import { createRoot } from 'react-dom/client'
import { toBase64Url } from '@workhub/protocol'
import { buildHub } from '../shared/hub-client'
import { startStore } from '../renderer/store'
import { App } from './App'
import type { WebApp } from './app-context'
import { currentPushSubscription, defaultDeviceName, detectPlatform, DESKTOPS_KEY, kvSet, registerServiceWorker, SEED_KEY } from './browser'
import { DEVICE_NAME_KEY } from './device'
import { RemoteClient } from './remote-client'
import { splitDesktop } from './routes'
import '../renderer/styles.css'
import './web.css'

// The theme follows the phone; the renderer's tokens paint from `data-theme`.
const dark = matchMedia('(prefers-color-scheme: dark)')
const paint = () => {
  document.documentElement.dataset['theme'] = dark.matches ? 'dark' : 'light'
}
paint()
dark.addEventListener('change', paint)

const platform = detectPlatform()
const defaultName = defaultDeviceName(platform)
const client = new RemoteClient({
  storage: {
    get: (k) => localStorage.getItem(k),
    set: (k, v) => localStorage.setItem(k, v),
    remove: (k) => localStorage.removeItem(k),
    keys: () => Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).filter((k): k is string => k !== null)
  },
  connect: (url) => new WebSocket(url),
  deviceName: () => localStorage.getItem(DEVICE_NAME_KEY) ?? defaultName,
  platform: () => platform,
  log: console
})

const hub = buildHub(client.transport, platform === 'ios' ? 'mac' : 'linux')
// Links open in the phone's browser, not through the desktop.
hub.openExternal = (url) => void window.open(url, '_blank', 'noopener')
window.hub = hub

// The service worker opens pushed notifications with this identity, and shows only those the
// paired desktops signed: it reads both from IndexedDB, which it shares with the page.
void kvSet(SEED_KEY, toBase64Url(client.identity.seed)).catch(() => {})
const mirrorDesktops = () => void kvSet(DESKTOPS_KEY, JSON.stringify(Object.fromEntries(client.desktops().map((d) => [d.id, d.public])))).catch(() => {})
mirrorDesktops()
client.onStatus(mirrorDesktops)
void registerServiceWorker().then(() => currentPushSubscription().then((sub) => sub && client.setPushSubscription(sub)))

// A hidden page drops its socket so the desktop pushes notifications instead; back in front, it reconnects.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) client.suspend()
  else client.start()
})
window.addEventListener('online', () => client.start())
// iOS can restore a frozen page without a visibility change; these check the socket is still alive.
window.addEventListener('pageshow', () => client.start())
window.addEventListener('focus', () => client.start())

// Opened from a notification of another paired desktop: switch to it before anything loads.
const opened = splitDesktop(location.hash)
if (opened.desktop) {
  client.switchDesktop(opened.desktop)
  history.replaceState(null, '', opened.hash)
}

startStore()
client.start()

const app: WebApp = { client, platform }
createRoot(document.getElementById('root')!).render(<App app={app} defaultName={defaultName} />)
