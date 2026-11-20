import { Component, useEffect, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { TooltipProvider } from '../renderer/components/atoms'
import { I18nProvider, useI18n } from '../renderer/i18n/I18nProvider'
import { getSessions, onEvent, onRemoved, startupList } from '../renderer/store'
import { refreshActivity } from './activity'
import type { PushPayload } from '@workhub/protocol'
import { WebAppProvider, navigate, useClient, useClientStatus, useRoute, type WebApp } from './app-context'
import { NOTIFY_ASKED_KEY } from './device'
import { kvSet, LOCALE_KEY } from './kv'
import { isAboutOpenSession, parseRoute, routeHash, type Route } from './routes'
import { AlertsScreen } from './screens/AlertsScreen'
import { AutomationsScreen } from './screens/AutomationsScreen'
import { HistoryScreen } from './screens/HistoryScreen'
import { HomeScreen } from './screens/HomeScreen'
import { NewSessionScreen } from './screens/NewSessionScreen'
import { NotifyScreen } from './screens/NotifyScreen'
import { PairScreen } from './screens/PairScreen'
import { PullRequestsScreen } from './screens/PullRequestsScreen'
import { SessionScreen } from './screens/SessionScreen'
import { SubagentScreen } from './screens/SubagentScreen'
import { ChangesScreen } from './screens/ChangesScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { PlanScreen } from './screens/PlanScreen'
import { NewItemScreen, PlanItemScreen } from './screens/PlanItemScreen'
import { MilestoneScreen } from './screens/MilestoneScreen'
import { useAppearance } from './appearance'
import { TabBar } from './ui'

interface Toast {
  id: number
  payload: PushPayload
}

const SWIPE_PX = 56

/**
 * Notifications that arrive over the live channel show briefly; a tap opens their session and a
 * swipe sideways dismisses one. They hang under the header (never over its back button or
 * actions), wherever it ends now: measured again on every render and whenever the header changes
 * size. A screen with no header leaves the room the status bar takes.
 */
function Toasts({ toasts, dismiss }: { toasts: Toast[]; dismiss: (id: number) => void }) {
  const client = useClient()
  const [top, setTop] = useState<number | null>(null)
  const swipe = useRef<{ id: number; x: number } | null>(null)
  // No dependency list: navigating swaps the header without changing the toasts.
  useLayoutEffect(() => {
    if (toasts.length === 0) return
    const header = document.querySelector('header')
    const measure = () => setTop(header ? Math.round(header.getBoundingClientRect().bottom) : null)
    measure()
    const watch = header && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    if (header) watch?.observe(header)
    window.addEventListener('resize', measure)
    return () => {
      watch?.disconnect()
      window.removeEventListener('resize', measure)
    }
  })
  if (toasts.length === 0) return null
  return (
    <div style={{ top: top === null ? 'calc(env(safe-area-inset-top, 0px) + 8px)' : top + 8 }} className="pointer-events-none fixed inset-x-0 z-30 flex flex-col items-center gap-2 px-3" data-testid="toasts">
      {toasts.map((toast) => (
        <button
          key={toast.id}
          type="button"
          onTouchStart={(e) => void (swipe.current = { id: toast.id, x: e.touches[0]?.clientX ?? 0 })}
          onTouchEnd={(e) => {
            const start = swipe.current
            swipe.current = null
            if (start?.id === toast.id && Math.abs((e.changedTouches[0]?.clientX ?? 0) - start.x) > SWIPE_PX) dismiss(toast.id)
          }}
          onClick={() => {
            dismiss(toast.id)
            const route = toast.payload.route ?? '#'
            if (toast.payload.desktop && toast.payload.desktop !== client.status().desktop?.id && client.switchDesktop(toast.payload.desktop)) {
              location.hash = route
              location.reload()
              return
            }
            navigate(parseRoute(route))
          }}
          className="pointer-events-auto min-h-11 w-full max-w-md rounded-xl border border-border bg-surface-raised px-4 py-3 text-left shadow-lg animate-slide-in"
        >
          <div className="truncate text-sm font-semibold">{toast.payload.title}</div>
          <div className="line-clamp-2 text-xs text-muted">{toast.payload.body}</div>
        </button>
      ))}
    </div>
  )
}

function Shell({ defaultName }: { defaultName: string }) {
  const { t, locale } = useI18n()
  const client = useClient()
  const status = useClientStatus()
  const route = useRoute()
  const [toasts, setToasts] = useState<Toast[]>([])
  const [askNotify, setAskNotify] = useState(() => !localStorage.getItem(NOTIFY_ASKED_KEY))
  const capabilities = status.desktop?.capabilities ?? []
  // The toast listener outlives renders: it reads the open screen and the desktop from here.
  const open = useRef<{ route: Route; desktop: string | undefined }>({ route, desktop: status.desktop?.id })
  open.current = { route, desktop: status.desktop?.id }
  useAppearance()
  // The service worker words a notification's buttons in the phone's language; it cannot read the page's settings.
  useEffect(() => void kvSet(LOCALE_KEY, locale).catch(() => {}), [locale])

  // Each time the desktop comes back: take its session list, dropping sessions closed meanwhile.
  useEffect(() => {
    if (status.state !== 'online') return
    const before = new Set(Object.keys(getSessions()))
    let ids: string[] = []
    void startupList(async () => {
      const views = await window.hub.sessions.list()
      ids = views.map((v) => v.id)
      // A list read in pages while it changed, or cut short, says nothing about the sessions it lacks.
      if (client.sessionsListComplete()) for (const id of before) if (!views.some((v) => v.id === id)) onRemoved(id)
      return views
    }).then(() => refreshActivity(client, ids, onEvent))
  }, [status.state])

  useEffect(() => {
    let seq = 0
    return client.transport.subscribe<[PushPayload]>('remote:notification', (payload) => {
      // About the chat already on screen: it would only repeat what the person is looking at.
      if (isAboutOpenSession(payload.route, payload.desktop, open.current.route, open.current.desktop, payload.kind)) return
      const id = ++seq
      setToasts((all) => [...all.slice(-2), { id, payload }])
      setTimeout(() => setToasts((all) => all.filter((x) => x.id !== id)), 6000)
    })
  }, [])

  // An offer waiting for confirmation shows the pairing screen even on a phone that is already paired (another computer).
  if (status.state === 'unpaired' || status.state === 'pairing' || status.state === 'revoked' || route.screen === 'pair' || status.offer) {
    if (route.screen === 'settings' && status.state !== 'pairing') return <SettingsScreen />
    return <PairScreen defaultName={defaultName} />
  }
  if (askNotify && status.state === 'online') return <NotifyScreen onDone={() => setAskNotify(false)} />

  let screen: ReactElement
  switch (route.screen) {
    case 'new':
      screen = capabilities.includes('sessions') ? <NewSessionScreen /> : <NotAllowed what={t('web.capability.sessions')} />
      break
    case 'session':
      screen = capabilities.includes('sessions') ? <SessionScreen id={route.id} /> : <NotAllowed what={t('web.capability.sessions')} />
      break
    case 'subagent':
      screen = capabilities.includes('sessions') ? <SubagentScreen sessionId={route.sessionId} id={route.id} /> : <NotAllowed what={t('web.capability.sessions')} />
      break
    case 'changes':
      screen = capabilities.includes('sessions') ? <ChangesScreen sessionId={route.sessionId} /> : <NotAllowed what={t('web.capability.sessions')} />
      break
    case 'pullRequests':
      screen = capabilities.includes('pullRequests') ? <PullRequestsScreen /> : <NotAllowed what={t('web.capability.pullRequests')} />
      break
    case 'alerts':
      screen = capabilities.includes('health') ? <AlertsScreen /> : <NotAllowed what={t('web.capability.health')} />
      break
    case 'automations':
      screen = capabilities.includes('automations') ? <AutomationsScreen /> : <NotAllowed what={t('web.capability.automations')} />
      break
    case 'plan':
      screen = capabilities.includes('plan') ? <PlanScreen tab={route.tab} /> : <NotAllowed what={t('web.capability.plan')} />
      break
    case 'planItem':
      screen = capabilities.includes('plan') ? <PlanItemScreen id={route.id} /> : <NotAllowed what={t('web.capability.plan')} />
      break
    case 'newItem':
      screen = capabilities.includes('plan') ? <NewItemScreen /> : <NotAllowed what={t('web.capability.plan')} />
      break
    case 'milestone':
      screen = capabilities.includes('plan') ? <MilestoneScreen id={route.id} /> : <NotAllowed what={t('web.capability.plan')} />
      break
    case 'settings':
      screen = <SettingsScreen />
      break
    case 'history':
      screen = capabilities.includes('sessions') ? <HistoryScreen /> : <NotAllowed what={t('web.capability.sessions')} />
      break
    default:
      screen = capabilities.includes('sessions') ? <HomeScreen /> : <SettingsScreen />
  }
  const chat = route.screen === 'session' || route.screen === 'subagent' || route.screen === 'new' || route.screen === 'newItem'
  return (
    <div className="flex h-full flex-col">
      <Toasts toasts={toasts} dismiss={(id) => setToasts((all) => all.filter((x) => x.id !== id))} />
      {/* Keyed by the route: another chat (or the same screen for another item) starts from fresh state and a fresh scroller. */}
      <div key={route.screen === 'plan' ? 'plan' : routeHash(route)} className="min-h-0 flex-1">
        {screen}
      </div>
      {!chat && <TabBar capabilities={capabilities} />}
    </div>
  )
}

function NotAllowed({ what }: { what: string }) {
  const { t } = useI18n()
  return <div className="flex h-full items-center justify-center px-8 text-center text-sm text-muted">{t('web.notAllowed', { what })}</div>
}

/** A crash in one screen shows its message and a way back instead of a blank page. */
class Crash extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  override render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center text-sm text-muted">
        <code className="text-danger [overflow-wrap:anywhere]">{this.state.error.message}</code>
        <button
          type="button"
          className="min-h-11 rounded-xl bg-accent px-4 font-semibold text-accent-fg"
          onClick={() => {
            this.setState({ error: null })
            navigate({ screen: 'home' }, true)
          }}
        >
          Workhub
        </button>
      </div>
    )
  }
}

export function App({ app, defaultName }: { app: WebApp; defaultName: string }) {
  return (
    <WebAppProvider value={app}>
      <I18nProvider>
        <TooltipProvider>
          <Crash>
            <Shell defaultName={defaultName} />
          </Crash>
        </TooltipProvider>
      </I18nProvider>
    </WebAppProvider>
  )
}
