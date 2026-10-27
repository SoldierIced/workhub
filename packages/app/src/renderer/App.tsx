import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { EffectiveAgent } from '@workhub/core'
import { TooltipProvider } from './components/atoms'
import { ToastProvider } from './components/molecules'
import { NewSessionDialog, Sidebar, Toolbar } from './components/organisms'
import { refreshConfig, useConfig } from './configStore'
import { I18nProvider, useI18n } from './i18n/I18nProvider'
import { planUsage, recentFolders } from './lib/home'
import { allNavItems, NEW_SESSION_SHORTCUT, SESSIONS_ITEM, visibleNavItems, type Route } from './lib/nav'
import { usePlatform } from './lib/platform'
import { resolveTheme, usePrefs, useSystemDark } from './lib/prefs'
import { ROUTE_LABEL } from './lib/routes'
import { matchesShortcut } from './lib/shortcuts'
import { HomeScreen } from './screens/HomeScreen'
import { PlaceholderScreen } from './screens/PlaceholderScreen'
import { SessionsScreen } from './screens/SessionsScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { TicketsScreen } from './screens/TicketsScreen'
import { startStore, useSessions } from './store'

/** Applies the theme preference to <html> and tells the main process (native chrome). */
function useTheme(): 'light' | 'dark' {
  const { theme } = usePrefs()
  const systemDark = useSystemDark()
  const resolved = resolveTheme(theme, systemDark)
  useEffect(() => {
    window.hub.setTheme(theme)
  }, [theme])
  useEffect(() => {
    document.documentElement.dataset['theme'] = resolved
  }, [resolved])
  return resolved
}

function Shell() {
  const { t } = useI18n()
  const platform = usePlatform()
  const theme = useTheme()
  const snap = useConfig()
  const sessionMap = useSessions()
  const [route, setRoute] = useState<Route>('home')
  const [settingsTab, setSettingsTab] = useState('general')
  const [selectedSession, setSelectedSession] = useState<string | null>(null)
  const [agents, setAgents] = useState<EffectiveAgent[]>([])
  const [dialog, setDialog] = useState<{ open: boolean; cwd?: string; agentKey?: string }>({ open: false })

  useEffect(() => {
    startStore()
    void refreshConfig()
  }, [])

  const profiles = snap?.config.profiles ?? []
  const activeProfileId = snap?.config.activeProfileId ?? null
  const profile = profiles.find((p) => p.id === activeProfileId)
  const navItems = visibleNavItems(profile?.modules)
  const reachable = useMemo(() => allNavItems(profile?.modules), [profile?.modules])

  useEffect(() => {
    if (!snap) return
    void window.hub.config.effectiveAgents(activeProfileId).then(setAgents)
  }, [snap, activeProfileId])

  // A module turned off in the active profile takes its screen with it.
  useEffect(() => {
    if (snap && !reachable.some((i) => i.route === route)) setRoute('home')
  }, [snap, reachable, route])

  const sessions = useMemo(() => Object.values(sessionMap).sort((a, b) => b.view.startedAt - a.view.startedAt), [sessionMap])

  const openSession = useCallback((id: string) => {
    setSelectedSession(id)
    setRoute('sessions')
  }, [])
  // A ticket window asked to show one of the sessions.
  useEffect(() => window.hub.tickets.onOpenSession(openSession), [openSession])
  const openSettings = useCallback((tab?: string) => {
    if (tab) setSettingsTab(tab)
    setRoute('settings')
  }, [])
  const navigate = useCallback((r: Route) => {
    if (r === 'sessions') setSelectedSession(null)
    setRoute(r)
  }, [])
  const newSession = useCallback((cwd?: string | null, agentKey?: string) => setDialog({ open: true, cwd: cwd ?? undefined, agentKey }), [])

  // CmdOrCtrl shortcuts for every nav item, plus CmdOrCtrl+T for a new session (Workhub 1's keys).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (matchesShortcut(e, NEW_SESSION_SHORTCUT, platform)) {
        e.preventDefault()
        newSession()
        return
      }
      const item = reachable.find((i) => matchesShortcut(e, i.shortcut, platform))
      if (item) {
        e.preventDefault()
        navigate(item.route)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [reachable, platform, navigate, newSession])

  const selectProfile = async (id: string) => {
    const r = await window.hub.config.setActiveProfile(id)
    if (r.ok) await refreshConfig()
  }

  const title = t(ROUTE_LABEL[route])

  return (
    <div className="flex h-full">
      <Sidebar
        route={route}
        navItems={navItems}
        sessionsItem={SESSIONS_ITEM}
        onNavigate={navigate}
        profiles={profiles}
        activeProfileId={activeProfileId}
        onSelectProfile={(id) => void selectProfile(id)}
        onManageProfiles={() => openSettings('profiles')}
        sessions={sessions.map((s) => s.view)}
        selectedSessionId={selectedSession}
        onSelectSession={openSession}
        folders={recentFolders(sessions)}
        onNewSessionIn={(f) => newSession(f)}
        usage={planUsage(sessions)}
      />
      <div className="flex min-w-0 flex-1 flex-col bg-bg">
        <Toolbar title={title} agents={agents} onNewSession={(key) => newSession(null, key)} onOpenSettings={() => openSettings()} />
        <main className="relative min-h-0 flex-1">
          {/* Sessions stay mounted so terminals and chats survive a visit to another screen. */}
          <div className={route === 'sessions' ? 'h-full' : 'hidden'}>
            <SessionsScreen sessions={sessions} selectedId={selectedSession} visible={route === 'sessions'} theme={theme} onNewSession={() => newSession()} />
          </div>
          {route !== 'sessions' && (
            <div key={route} className="h-full animate-fade-in overflow-y-auto">
              {route === 'home' ? (
                <HomeScreen profile={profile} sessions={sessions} onOpenSession={openSession} onOpenSettings={openSettings} onNavigate={navigate} />
              ) : route === 'tickets' ? (
                <TicketsScreen profile={profile} sessions={sessions} onOpenSettings={openSettings} />
              ) : route === 'settings' ? (
                <SettingsScreen snap={snap} tab={settingsTab} onTabChange={setSettingsTab} />
              ) : (
                <PlaceholderScreen route={route} title={t(ROUTE_LABEL[route])} />
              )}
            </div>
          )}
        </main>
      </div>
      <NewSessionDialog
        open={dialog.open}
        onOpenChange={(open) => setDialog((d) => ({ ...d, open }))}
        profileId={activeProfileId}
        agents={agents}
        initialCwd={dialog.cwd}
        initialAgentKey={dialog.agentKey}
        onStarted={openSession}
      />
    </div>
  )
}

export function App() {
  return (
    <I18nProvider>
      <AppProviders>
        <Shell />
      </AppProviders>
    </I18nProvider>
  )
}

function AppProviders({ children }: { children: ReactNode }) {
  const { t } = useI18n()
  return (
    <TooltipProvider>
      <ToastProvider label={t('common.notifications')}>{children}</ToastProvider>
    </TooltipProvider>
  )
}
