import { Component, useEffect, useState, type ReactElement, type ReactNode } from 'react'
import { TooltipProvider } from '../renderer/components/atoms'
import { I18nProvider, useI18n } from '../renderer/i18n/I18nProvider'
import { getSessions, onRemoved, startupList } from '../renderer/store'
import type { PushPayload } from '@workhub/protocol'
import { WebAppProvider, navigate, useClient, useClientStatus, useRoute, type WebApp } from './app-context'
import { NOTIFY_ASKED_KEY } from './device'
import { parseRoute, routeHash } from './routes'
import { AlertsScreen } from './screens/AlertsScreen'
import { HomeScreen } from './screens/HomeScreen'
import { NewSessionScreen } from './screens/NewSessionScreen'
import { NotifyScreen } from './screens/NotifyScreen'
import { PairScreen } from './screens/PairScreen'
import { PullRequestsScreen } from './screens/PullRequestsScreen'
import { SessionScreen } from './screens/SessionScreen'
import { SubagentScreen } from './screens/SubagentScreen'
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

/** Notifications that arrive over the live channel show briefly at the top; a tap opens their session. */
function Toasts({ toasts, dismiss }: { toasts: Toast[]; dismiss: (id: number) => void }) {
  const client = useClient()
  if (toasts.length === 0) return null
  return (
    <div className="safe-top pointer-events-none fixed inset-x-0 top-0 z-50 flex flex-col items-center gap-2 px-3 pt-2">
      {toasts.map((toast) => (
        <button
          key={toast.id}
          type="button"
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
          className="pointer-events-auto w-full max-w-md rounded-xl border border-border bg-surface-raised px-4 py-3 text-left shadow-lg animate-slide-in"
        >
          <div className="truncate text-sm font-semibold">{toast.payload.title}</div>
          <div className="line-clamp-2 text-xs text-muted">{toast.payload.body}</div>
        </button>
      ))}
    </div>
  )
}

function Shell({ defaultName }: { defaultName: string }) {
  const { t } = useI18n()
  const client = useClient()
  const status = useClientStatus()
  const route = useRoute()
  const [toasts, setToasts] = useState<Toast[]>([])
  const [askNotify, setAskNotify] = useState(() => !localStorage.getItem(NOTIFY_ASKED_KEY))
  const capabilities = status.desktop?.capabilities ?? []
  useAppearance()

  // Each time the desktop comes back: take its session list, dropping sessions closed meanwhile.
  useEffect(() => {
    if (status.state !== 'online') return
    const before = new Set(Object.keys(getSessions()))
    void startupList(async () => {
      const views = await window.hub.sessions.list()
      for (const id of before) if (!views.some((v) => v.id === id)) onRemoved(id)
      return views
    })
  }, [status.state])

  useEffect(() => {
    let seq = 0
    return client.transport.subscribe<[PushPayload]>('remote:notification', (payload) => {
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
    case 'pullRequests':
      screen = capabilities.includes('pullRequests') ? <PullRequestsScreen /> : <NotAllowed what={t('web.capability.pullRequests')} />
      break
    case 'alerts':
      screen = capabilities.includes('health') ? <AlertsScreen /> : <NotAllowed what={t('web.capability.health')} />
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
          className="h-10 rounded-xl bg-accent px-4 font-semibold text-accent-fg"
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
