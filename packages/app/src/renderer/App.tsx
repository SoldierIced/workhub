import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { appOptions, EMPTY_SESSION_GROUPS, groupOf, investigateSlowEndpointPrompt, notificationTitle, pickAgent, refreshMembers, sessionIdentity, setGroupCollapsed, type EffectiveAgent, type GroupMember, type SlowTransaction } from '@workhub/core'
import type { HealthEnvironmentView } from '@shared/health-api'
import { TooltipProvider } from './components/atoms'
import { ToastProvider, useToast } from './components/molecules'
import { NewSessionDialog, Sidebar, Toolbar } from './components/organisms'
import { dropOnSessionsTitle, SessionList } from './components/organisms/SessionList'
import { refreshConfig, useConfig } from './configStore'
import { I18nProvider, useI18n } from './i18n/I18nProvider'
import { setComposerDraft } from './lib/drafts'
import { runIntent, type IntentDeps } from './lib/links'
import { keyProviders } from './lib/tickets'
import type { SessionIntent } from '@shared/links-api'
import { folderForService } from './lib/health'
import { recentFolders, usageGroups } from './lib/home'
import { allNavItems, NEW_SESSION_SHORTCUT, SESSIONS_ITEM, visibleNavItems, type Route } from './lib/nav'
import { usePlatform } from './lib/platform'
import { NOTIFY_BODY, NOTIFY_OPTION } from './lib/attention'
import { resolveTheme, readPrefs, usePrefs, useSystemDark } from './lib/prefs'
import { listSessions, memberOf, updateGroups } from './lib/sessionGroups'
import { ROUTE_LABEL } from './lib/routes'
import { matchesShortcut } from './lib/shortcuts'
import { useAccountUsage } from './lib/usage'
import { usePrEventNotifications } from './lib/usePrEventNotifications'
import { HistoryScreen } from './screens/HistoryScreen'
import { HealthScreen } from './screens/HealthScreen'
import { HomeScreen } from './screens/HomeScreen'
import { PlaceholderScreen } from './screens/PlaceholderScreen'
import { PullRequestsScreen } from './screens/PullRequestsScreen'
import { SessionsScreen } from './screens/SessionsScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { TicketsScreen } from './screens/TicketsScreen'
import { onAttention, setViewing, startStore, useSessions } from './store'

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
  const { t, tn, locale } = useI18n()
  const toast = useToast()
  const platform = usePlatform()
  const theme = useTheme()
  const snap = useConfig()
  const sessionMap = useSessions()
  const accountUsage = useAccountUsage()
  const [route, setRoute] = useState<Route>('home')
  const [settingsTab, setSettingsTab] = useState('general')
  const [selectedSession, setSelectedSession] = useState<string | null>(null)
  const [prFocus, setPrFocus] = useState<string | null>(null)
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

  const groups = snap?.config.sessionGroups ?? EMPTY_SESSION_GROUPS
  const listed = useMemo(() => listSessions(sessions), [sessions])
  const liveKeys = useMemo(() => listed.map((s) => s.key), [listed])
  // Latest values for callbacks that outlive a render (notifications, opening a session).
  const latest = useRef({ sessions, groups, snap, t, tn, liveKeys })
  latest.current = { sessions, groups, snap, t, tn, liveKeys }
  usePrEventNotifications(() => latest.current)

  const openSession = useCallback((id: string) => {
    setSelectedSession(id)
    setRoute('sessions')
    // Opening a session from anywhere (Home, a ticket, a notification) shows it: its group unfolds.
    const view = latest.current.sessions.find((s) => s.view.id === id)?.view
    const group = view && groupOf(latest.current.groups, sessionIdentity(view))
    if (group?.collapsed) void updateGroups((g) => setGroupCollapsed(g, group.id, false), latest.current.liveKeys)
  }, [])

  // A session counts as seen only while its screen is up (and the window focused: the store tracks that).
  useEffect(() => setViewing(route === 'sessions' ? selectedSession : null), [route, selectedSession])

  // Sessions that need a look get an OS notification, named after their group when they have one.
  useEffect(
    () =>
      onAttention((id, kind) => {
        const { sessions: all, groups: stored, snap: config, t: tr } = latest.current
        const options = appOptions(config?.config ?? { options: undefined })
        const data = all.find((s) => s.view.id === id)
        if (!data || !options[NOTIFY_OPTION[kind]]) return
        const group = groupOf(stored, sessionIdentity(data.view))
        window.hub.notifications.show({ title: notificationTitle(data.view.agentName, group?.name), body: tr(NOTIFY_BODY[kind]), sessionId: id })
      }),
    []
  )
  useEffect(() => window.hub.notifications.onOpen(openSession), [openSession])

  // Members remember their title, agent and folder so they can be listed (and reopened) once closed.
  useEffect(() => {
    if (!snap || snap.loadError) return
    const live = listed.map(memberOf)
    if (refreshMembers(groups, live) !== groups) void updateGroups((g) => refreshMembers(g, live), liveKeys)
  }, [snap, groups, listed, liveKeys])
  const openPullRequest = useCallback((url?: string) => {
    setPrFocus(url ?? null)
    setRoute('pullRequests')
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

  const reopenMember = async (member: GroupMember) => {
    const choice = agents.find((a) => a.key === member.agentKey)
    // Claude and agents with their own terminal UI resume by session id; others start again under the same identity.
    const resumes = choice ? choice.agent.adapter === 'native' || Boolean(choice.agent.console) : false
    try {
      const view = await window.hub.sessions.start({
        profileId: activeProfileId,
        agentKey: member.agentKey,
        cwd: member.cwd,
        cols: 100,
        rows: 30,
        model: readPrefs().models[member.agentKey],
        ...(resumes ? { resumeAgentSessionId: member.key } : { identity: member.key })
      })
      openSession(view.id)
    } catch (e) {
      toast(t('groups.reopenFailed', { message: e instanceof Error ? e.message : String(e) }), 'danger')
    }
  }

  // Investigate with Claude: a new app-mode session in the service's folder with the summary in the composer, not sent.
  const investigate = async (env: HealthEnvironmentView, tx: SlowTransaction) => {
    const claude = pickAgent(profile, agents, 'claude')
    if (!claude) return toast(t('health.investigate.noAgent'), 'danger')
    try {
      const cwd = folderForService(profile?.folders ?? [], tx.service) ?? (await window.hub.getDefaultCwd())
      const view = await window.hub.sessions.start({ profileId: activeProfileId, agentKey: claude.key, cwd, cols: 100, rows: 30, mode: 'app', model: readPrefs().models[claude.key] })
      setComposerDraft(view.id, investigateSlowEndpointPrompt({ name: env.name, slowFlowHours: env.slowFlowHours }, tx))
      openSession(view.id)
      toast(t('health.investigate.drafted'))
    } catch (e) {
      toast(t('health.investigate.failed', { message: e instanceof Error ? e.message : String(e) }), 'danger')
    }
  }

  // A pull request or ticket window (or screen) asked for a session: open it, or start one with a drafted, unsent prompt.
  const linkDeps = useRef<Pick<IntentDeps, 'agents' | 'profile' | 'sessions' | 'locale'>>({ agents, profile, sessions, locale })
  linkDeps.current = { agents, profile, sessions, locale }
  useEffect(
    () =>
      window.hub.links.onIntent((intent: SessionIntent) => {
        const deps: IntentDeps = {
          ...linkDeps.current,
          checkouts: (profileId) => window.hub.links.checkouts(profileId),
          providers: async (profileId) => keyProviders(await window.hub.tickets.status(profileId)),
          defaultCwd: () => window.hub.getDefaultCwd(),
          model: (agentKey) => readPrefs().models[agentKey],
          start: (input) => window.hub.sessions.start(input),
          setDraft: setComposerDraft
        }
        void runIntent(deps, intent).then((outcome) => {
          const tr = latest.current.t
          if (outcome.kind === 'error') return toast(tr(outcome.message, outcome.params), 'danger')
          openSession(outcome.sessionId)
          toast(outcome.kind === 'opened' ? tr('links.opened') : outcome.drafted ? tr('links.drafted') : tr('links.started', { folder: outcome.folder }))
        })
      }),
    [openSession, toast]
  )

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
        sessionList={
          <SessionList
            sessions={sessions}
            groups={groups}
            selectedId={selectedSession}
            active={route === 'sessions'}
            onSelect={openSession}
            onReopen={(m) => void reopenMember(m)}
          />
        }
        attentionCount={sessions.filter((s) => s.unseen).length}
        onDropOnSessions={(e) => dropOnSessionsTitle(e, liveKeys)}
        folders={recentFolders(sessions, profile?.folders)}
        onNewSessionIn={(f) => newSession(f)}
        usage={usageGroups(sessions, accountUsage)}
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
                <HomeScreen
                  profile={profile}
                  sessions={sessions}
                  onOpenSession={openSession}
                  onOpenSettings={openSettings}
                  onOpenPullRequest={openPullRequest}
                  onNavigate={navigate}
                />
              ) : route === 'history' ? (
                <HistoryScreen profileId={activeProfileId} onOpened={openSession} />
              ) : route === 'pullRequests' ? (
                <PullRequestsScreen profile={profile} focusUrl={prFocus} onOpenSettings={openSettings} />
              ) : route === 'health' ? (
                <HealthScreen profile={profile} onOpenSettings={openSettings} onInvestigate={(env, tx) => void investigate(env, tx)} />
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
        preferredAgents={profile?.preferredAgents}
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
