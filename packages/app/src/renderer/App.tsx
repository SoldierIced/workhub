import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { appOptions, EMPTY_SESSION_GROUPS, groupOf, notificationTitle, pickAgent, refreshMembers, sessionIdentity, setGroupCollapsed, type EffectiveAgent, type GroupMember } from '@workhub/core'
import type { SessionView, WorkspaceFolder } from '@shared/api'
import { Button, TooltipProvider } from './components/atoms'
import { Dialog, ToastProvider, useToast } from './components/molecules'
import { NewSessionDialog, Sidebar, Toolbar } from './components/organisms'
import { dropOnSessionsTitle, isWorking, SessionList } from './components/organisms/SessionList'
import { RenameSessionDialog } from './components/organisms/RenameSessionDialog'
import { ResumeSheet } from './components/organisms/ResumeSheet'
import { DetachedSessionNotice } from './screens/sessions/DetachedSessionNotice'
import { useDetachedSessions } from './lib/windows'
import type { MenuCommand } from '@shared/windows-api'
import { refreshConfig, useConfig } from './configStore'
import { I18nProvider, useI18n } from './i18n/I18nProvider'
import { setComposerDraft } from './lib/drafts'
import { runIntent, type IntentDeps } from './lib/links'
import { keyProviders } from './lib/tickets'
import type { SessionIntent } from '@shared/links-api'
import { usageGroups } from './lib/home'
import { allNavItems, NEW_SESSION_SHORTCUT, SESSIONS_ITEM, visibleNavItems, type Route } from './lib/nav'
import { usePlatform } from './lib/platform'
import { NOTIFY_BODY, NOTIFY_OPTION } from './lib/attention'
import { readPrefs } from './lib/prefs'
import { useAppearance } from './lib/appearance'
import { listSessions, memberOf, sessionLabel, updateGroups } from './lib/sessionGroups'
import { ROUTE_LABEL } from './lib/routes'
import { matchesShortcut } from './lib/shortcuts'
import { useAccountUsage, useUsageAlerts } from './lib/usage'
import { usePrEventNotifications } from './lib/usePrEventNotifications'
import { useAiReviewNotices } from './lib/useAiReviewNotices'
import { useChatNotices } from './lib/useChatNotices'
import { useContinuity } from './lib/continuity'
import { useTraySync } from './lib/useTraySync'
import { useReadAloud } from './lib/readAloud'
import { AutomationsScreen } from './screens/AutomationsScreen'
import { SlackScreen } from './screens/SlackScreen'
import { HistoryScreen } from './screens/HistoryScreen'
import { HealthScreen } from './screens/HealthScreen'
import { HomeScreen } from './screens/HomeScreen'
import { PlaceholderScreen } from './screens/PlaceholderScreen'
import { PullRequestsScreen } from './screens/PullRequestsScreen'
import { SessionsScreen } from './screens/SessionsScreen'
import { SettingsDialog } from './screens/SettingsDialog'
import { SubagentSheet } from './screens/sessions/SubagentView'
import { TicketsScreen } from './screens/TicketsScreen'
import { onAttention, sessionSnapshot, setExternalViewing, setViewing, startStore, useSessions, type SessionData } from './store'
import { errorText } from './lib/errorText'
import { startPromptQueue } from './promptQueue'

/** Applies the appearance preferences to <html> and tells the main process (native chrome). */
function useTheme(): 'light' | 'dark' {
  return useAppearance()
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
  // Settings is a modal over whatever screen is up, not a screen of its own.
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [selectedSession, setSelectedSession] = useState<string | null>(null)
  const [prFocus, setPrFocus] = useState<string | null>(null)
  const [agents, setAgents] = useState<EffectiveAgent[]>([])
  const [dialog, setDialog] = useState<{ open: boolean; cwd?: string; agentKey?: string }>({ open: false })
  const [renaming, setRenaming] = useState<SessionView | null>(null)
  const [resumeFolder, setResumeFolder] = useState<string | null>(null)
  const [closing, setClosing] = useState<SessionData | null>(null)
  // Sessions shown in windows of their own: the main window shows a placeholder for them.
  const detached = useDetachedSessions()

  useEffect(() => {
    startStore()
    startPromptQueue()
    void refreshConfig()
    // Main moves a session's group place to its real id by itself; the stale copy must not be saved back.
    return window.hub.config.onChanged(() => void refreshConfig())
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

  // The sidebar's folder browser: the profile's folders and the folders inside them, read again when they change.
  const [workspaces, setWorkspaces] = useState<WorkspaceFolder[]>([])
  const folderKey = JSON.stringify(profile?.folders ?? [])
  useEffect(() => {
    let alive = true
    void window.hub.profileFolders(activeProfileId).then((list) => alive && setWorkspaces(list), () => alive && setWorkspaces([]))
    return () => {
      alive = false
    }
  }, [activeProfileId, folderKey])

  // A module turned off in the active profile takes its screen with it.
  useEffect(() => {
    if (snap && !reachable.some((i) => i.route === route)) setRoute('home')
  }, [snap, reachable, route])

  const sessions = useMemo(() => Object.values(sessionMap).sort((a, b) => b.view.startedAt - a.view.startedAt), [sessionMap])
  // A session in its own window is not mounted here too: one terminal per session, one size.
  const docked = useMemo(() => sessions.filter((s) => !detached.has(s.view.id)), [sessions, detached])

  const groups = snap?.config.sessionGroups ?? EMPTY_SESSION_GROUPS
  const listed = useMemo(() => listSessions(sessions), [sessions])
  const liveKeys = useMemo(() => listed.map((s) => s.key), [listed])
  // Latest values for callbacks that outlive a render (notifications, opening a session).
  const latest = useRef({ sessions, groups, snap, t, tn, liveKeys })
  latest.current = { sessions, groups, snap, t, tn, liveKeys }
  usePrEventNotifications(() => latest.current)
  useChatNotices()
  useReadAloud(sessionMap, appOptions(snap?.config ?? { options: undefined }), platform)
  useAiReviewNotices()
  // An automation moved a session's sidebar place in the stored config.
  useEffect(() => window.hub.automations.onConfigChanged(() => void refreshConfig()), [])

  const openSession = useCallback((id: string) => {
    setSelectedSession(id)
    setRoute('sessions')
    setSettingsOpen(false)
    // Opening a session from anywhere (Home, a ticket, a notification) shows it: its group unfolds.
    const view = latest.current.sessions.find((s) => s.view.id === id)?.view
    const group = view && groupOf(latest.current.groups, sessionIdentity(view))
    if (group?.collapsed) void updateGroups((g) => setGroupCollapsed(g, group.id, false), latest.current.liveKeys)
  }, [])
  // Usage-limit offers, and following a session main moved to another account by itself.
  useContinuity(openSession, selectedSession)

  // Session windows: "Move to Main Window" selects the session here; a focused one counts as seen;
  // a new one starts from the chat this window holds.
  useEffect(() => window.hub.windows.onShowSession(openSession), [openSession])
  useEffect(() => window.hub.windows.onFocusedSession(setExternalViewing), [])
  useEffect(() => window.hub.windows.onSnapshotRequest((requestId, id) => window.hub.windows.replySnapshot(requestId, sessionSnapshot(id))), [])

  // A session counts as seen only while its screen is up (and the window focused: the store tracks that).
  useEffect(() => {
    const viewing = route === 'sessions' ? selectedSession : null
    setViewing(viewing)
    // A replaced automation session on screen is never closed under the user.
    window.hub.automations.setViewing(viewing)
  }, [route, selectedSession])

  // Sessions that need a look get an OS notification, named after their group when they have one.
  useEffect(
    () =>
      onAttention((id, kind) => {
        const { sessions: all, groups: stored, snap: config, t: tr } = latest.current
        const options = appOptions(config?.config ?? { options: undefined })
        const data = all.find((s) => s.view.id === id)
        // An AI reviewer's turns are reported by the review itself (Review panel and its notices).
        if (!data || data.view.readOnly || !options[NOTIFY_OPTION[kind]]) return
        const group = groupOf(stored, sessionIdentity(data.view))
        window.hub.notifications.show({ title: notificationTitle(sessionLabel(data), group?.name), body: tr(NOTIFY_BODY[kind]), sessionId: id, kind })
      }),
    []
  )
  // Usage alerts (Settings → Usage): a click opens Home, where "Usage by agent" is.
  const showScreen = useCallback((r: Route) => {
    setSettingsOpen(false)
    setRoute(r)
  }, [])
  useUsageAlerts(useCallback(() => showScreen('home'), [showScreen]))
  // Slack notices have no session: their click opens the Slack screen.
  useEffect(() => window.hub.notifications.onOpen((id) => (id ? openSession(id) : showScreen('slack'))), [openSession, showScreen])

  // Members remember their title, agent and folder so they can be listed (and reopened) once closed.
  useEffect(() => {
    if (!snap || snap.loadError) return
    const live = listed.map(memberOf)
    if (refreshMembers(groups, live) !== groups) void updateGroups((g) => refreshMembers(g, live), liveKeys)
  }, [snap, groups, listed, liveKeys])
  const openPullRequest = useCallback((url?: string) => {
    setPrFocus(url ?? null)
    showScreen('pullRequests')
  }, [showScreen])
  // A pull request window asked to show its PR here.
  // The PR may belong to another profile than the one the main window shows: switch to it first.
  useEffect(
    () =>
      window.hub.codeHost.onFocus((url, profileId) => {
        void (async () => {
          if (profileId && profileId !== activeProfileId && profiles.some((p) => p.id === profileId)) {
            const r = await window.hub.config.setActiveProfile(profileId)
            if (r.ok) await refreshConfig()
          }
          openPullRequest(url)
        })()
      }),
    [openPullRequest, activeProfileId, profiles]
  )
  // A ticket window asked to show one of the sessions.
  useEffect(() => window.hub.tickets.onOpenSession(openSession), [openSession])
  const openSettings = useCallback((tab?: string) => {
    if (tab) setSettingsTab(tab)
    setSettingsOpen(true)
  }, [])
  // Every way to Settings (sidebar, ⌘,, the menu bar icon, links to a tab) opens the modal.
  const navigate = useCallback(
    (r: Route, tab?: string) => {
      if (r === 'settings') return openSettings(tab)
      if (r === 'sessions') setSelectedSession(null)
      showScreen(r)
    },
    [openSettings, showScreen]
  )
  // A setup window's fix button asked for a Settings tab.
  useEffect(() => window.hub.setup.onOpenSettings((tab) => openSettings(tab)), [openSettings])
  const newSession = useCallback((cwd?: string | null, agentKey?: string) => setDialog({ open: true, cwd: cwd ?? undefined, agentKey }), [])
  // The menu bar / notification area icon: it lists the sessions and opens screens and the new session dialog.
  useTraySync({ sessions, groups, locale, navigate, newSession: () => newSession() })

  // The application menu (main sends its commands to the window they act on).
  const menuState = useRef({ route, selectedSession, reachable, sessions })
  menuState.current = { route, selectedSession, reachable, sessions }
  useEffect(
    () =>
      window.hub.menu.onCommand((command: MenuCommand) => {
        const { route: now, selectedSession: selected, reachable: items, sessions: all } = menuState.current
        const current = now === 'sessions' ? all.find((s) => s.view.id === selected) : undefined
        switch (command.kind) {
          case 'navigate': {
            const item = items.find((i) => i.route === command.route)
            if (item) navigate(item.route)
            return
          }
          case 'newSession':
            return newSession(null, command.agentKey)
          case 'closeSession':
            if (current) {
              if (isWorking(current)) setClosing(current)
              else void window.hub.sessions.close(current.view.id)
            }
            return
          case 'openInWindow':
            if (current && current.view.state !== 'stopped') window.hub.windows.openSession(current.view.id)
            return
          case 'showMode':
            if (current?.view.modes.includes(command.mode)) void window.hub.sessions.setMode(current.view.id, command.mode).catch(() => undefined)
            return
        }
      }),
    [navigate, newSession]
  )

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
      // The same single start per identity as a Slack wake: both at once open one session.
      const view = await window.hub.sessions.reopen(member.key, {
        profileId: activeProfileId,
        agentKey: member.agentKey,
        cwd: member.cwd,
        cols: 100,
        rows: 30,
        model: readPrefs().models[member.agentKey],
        modeId: readPrefs().modes[member.agentKey],
        ...(resumes ? { resumeAgentSessionId: member.key } : { identity: member.key })
      })
      openSession(view.id)
    } catch (e) {
      toast(t('groups.reopenFailed', { message: errorText(e) }), 'danger')
    }
  }

  // Investigate with Claude: a new app-mode session in the repository's folder (the profile's first one when no
  // folder matches) with the draft in the composer, not sent.
  const investigate = async (draft: string, folder: string | undefined) => {
    const claude = pickAgent(profile, agents, 'claude')
    if (!claude) return toast(t('health.investigate.noAgent'), 'danger')
    try {
      const cwd = folder ?? profile?.folders?.[0] ?? (await window.hub.getDefaultCwd())
      const view = await window.hub.sessions.start({ profileId: activeProfileId, agentKey: claude.key, cwd, cols: 100, rows: 30, mode: 'app', model: readPrefs().models[claude.key] })
      setComposerDraft(view.id, draft)
      openSession(view.id)
      toast(t('health.investigate.drafted'))
    } catch (e) {
      toast(t('health.investigate.failed', { message: errorText(e) }), 'danger')
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
            profiles={profiles}
            onOpenSlack={reachable.some((i) => i.route === 'slack') ? () => navigate('slack') : undefined}
            onRename={setRenaming}
            onOpenInWindow={(id) => window.hub.windows.openSession(id)}
          />
        }
        attentionCount={sessions.filter((s) => s.unseen).length}
        onDropOnSessions={(e) => dropOnSessionsTitle(e, liveKeys)}
        workspaces={workspaces}
        onNewSessionIn={(f) => newSession(f)}
        onResumeIn={setResumeFolder}
        usage={usageGroups(sessions, accountUsage)}
      />
      <div className="flex min-w-0 flex-1 flex-col bg-bg">
        <Toolbar title={title} agents={agents} onNewSession={(key) => newSession(null, key)} onOpenSettings={() => openSettings()} />
        <main className="relative min-h-0 flex-1">
          {/* Sessions stay mounted so terminals and chats survive a visit to another screen. */}
          <div className={route === 'sessions' ? 'relative h-full' : 'hidden'}>
            <SessionsScreen sessions={docked} selectedId={selectedSession} visible={route === 'sessions'} theme={theme} onNewSession={() => newSession()} />
            {selectedSession && detached.has(selectedSession) && <DetachedSessionNotice data={sessionMap[selectedSession]} />}
          </div>
          {route !== 'sessions' && (
            <div key={route} className="h-full animate-fade-in overflow-y-auto">
              {route === 'home' ? (
                <HomeScreen
                  profile={profile}
                  sessions={sessions}
                  usage={accountUsage}
                  onOpenSession={openSession}
                  onOpenSettings={openSettings}
                  onOpenPullRequest={openPullRequest}
                  onNavigate={navigate}
                />
              ) : route === 'history' ? (
                <HistoryScreen profileId={activeProfileId} profiles={profiles} onOpened={openSession} />
              ) : route === 'pullRequests' ? (
                <PullRequestsScreen profile={profile} focusUrl={prFocus} onOpenSettings={openSettings} />
              ) : route === 'health' ? (
                <HealthScreen profile={profile} onOpenSettings={openSettings} onInvestigate={investigate} />
              ) : route === 'tickets' ? (
                <TicketsScreen profile={profile} sessions={sessions} onOpenSettings={openSettings} />
              ) : route === 'slack' ? (
                <SlackScreen profile={profile} sessions={sessions} onOpenSession={openSession} onOpenSettings={openSettings} />
              ) : route === 'automations' ? (
                <AutomationsScreen profile={profile} agents={agents} onOpenSession={openSession} />
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
      <SubagentSheet />
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} snap={snap} tab={settingsTab} onTabChange={setSettingsTab} />
      <RenameSessionDialog session={renaming} onClose={() => setRenaming(null)} />
      <ResumeSheet folder={resumeFolder} profileId={activeProfileId} onClose={() => setResumeFolder(null)} onOpened={openSession} />
      {closing && (
        <Dialog
          open
          onOpenChange={(o) => !o && setClosing(null)}
          title={t('sessions.closeTitle', { name: closing.view.name || closing.view.agentName })}
          description={t('sessions.closeBody')}
          footer={
            <>
              <Button variant="ghost" onClick={() => setClosing(null)}>
                {t('common.cancel')}
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  void window.hub.sessions.close(closing.view.id)
                  setClosing(null)
                }}
              >
                {t('sessions.closeConfirm')}
              </Button>
            </>
          }
        >
          {null}
        </Dialog>
      )}
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
