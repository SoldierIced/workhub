import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { appOptions, EMPTY_SESSION_GROUPS, groupOf, notificationTitle, orderAgents, pickAgent, profileDefaultFolder, refreshMembers, sessionIdentity, setGroupCollapsed, worktreeDefault, type EffectiveAgent, type GroupMember } from '@workhub/core'
import type { SessionView, WorkspaceFolder } from '@shared/api'
import { TooltipProvider } from './components/atoms'
import { ToastProvider, useToast } from './components/molecules'
import { NewSessionDialog, Sidebar, Toolbar } from './components/organisms'
import { TopNav } from './components/organisms/TopNav'
import { dropOnSessionsTitle, isWorking, SessionList } from './components/organisms/SessionList'
import { RenameSessionDialog } from './components/organisms/RenameSessionDialog'
import { CloseSessionDialog } from './components/organisms/CloseSessionDialog'
import { closeAsks } from './lib/closeSession'
import { UpdatePromptDialog } from './components/organisms/UpdatePromptDialog'
import { ResumeSheet } from './components/organisms/ResumeSheet'
import { DetachedSessionNotice } from './screens/sessions/DetachedSessionNotice'
import { useDetachedSessions } from './lib/windows'
import type { MenuCommand } from '@shared/windows-api'
import { currentConfig, refreshConfig, useConfig } from './configStore'
import { I18nProvider, useI18n } from './i18n/I18nProvider'
import { setComposerDraft } from './lib/drafts'
import { runIntent, type IntentDeps } from './lib/links'
import { keyProviders } from './lib/tickets'
import type { SessionIntent } from '@shared/links-api'
import { usageGroups } from './lib/home'
import { allNavItems, MONITOR_SHORTCUT, NEW_SESSION_SHORTCUT, SESSIONS_ITEM, SIDEBAR_SHORTCUT, visibleNavItems, type Route } from './lib/nav'
import { usePlatform } from './lib/platform'
import { attentionDetail, NOTIFY_BODY, NOTIFY_OPTION } from './lib/attention'
import { readPrefs, setPrefs, usePrefs } from './lib/prefs'
import { useAppearance } from './lib/appearance'
import { historyLookupKeys, listSessions, lookUpHistory, memberOf, sameRows, sessionLabel, updateGroups } from './lib/sessionGroups'
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
import { FlowMapsScreen } from './screens/flowMaps/FlowMapsScreen'
import { PlanScreen } from './screens/plan/PlanScreen'
import { HomeScreen } from './screens/HomeScreen'
import { PullRequestsScreen } from './screens/PullRequestsScreen'
import { SessionsScreen } from './screens/SessionsScreen'
import { SubagentSheet } from './screens/sessions/SubagentView'
import { TicketsScreen } from './screens/TicketsScreen'
import { onAttention, sessionSnapshot, setExternalViewing, setViewing, startStore, useSessions, type SessionData } from './store'
import { errorText } from './lib/errorText'
import { quickSessionPlan } from './lib/quickSession'
import { createQuickSessionGate } from './lib/quickSessionGate'
import { abbreviateFolder } from './lib/sessionHeader'
import { startPromptQueue } from './promptQueue'

/** Applies the appearance preferences to <html> and tells the main process (native chrome). */
function useTheme(): 'light' | 'dark' {
  return useAppearance()
}

/** Screens kept mounted (hidden) after their first visit; the others remount, which also re-reads their data. */
const KEPT_ROUTES: ReadonlySet<Route> = new Set<Route>(['history', 'pullRequests'])
const SCREEN_PANE = 'h-full animate-fade-in [scrollbar-gutter:stable] overflow-y-auto'

function Shell() {
  const { t, tn, locale } = useI18n()
  const toast = useToast()
  const platform = usePlatform()
  const theme = useTheme()
  const snap = useConfig()
  const sessionMap = useSessions()
  const accountUsage = useAccountUsage()
  const [route, setRoute] = useState<Route>('home')
  // History and Pull requests stay mounted once visited: filters, selection and loaded lists survive a trip elsewhere.
  const [visited, setVisited] = useState<ReadonlySet<Route>>(() => new Set())
  useEffect(() => {
    if (KEPT_ROUTES.has(route)) setVisited((prev) => (prev.has(route) ? prev : new Set(prev).add(route)))
  }, [route])
  const kept = KEPT_ROUTES.has(route) && !visited.has(route) ? [...visited, route] : [...visited]
  const [selectedSession, setSelectedSession] = useState<string | null>(null)
  // A new object per request, so asking for the same PR again focuses it again.
  const [prFocus, setPrFocus] = useState<{ url: string } | null>(null)
  // The agents of the profile they were read for: another profile's list never shows (or starts) here.
  const [agentList, setAgentList] = useState<{ profileId: string | null; list: EffectiveAgent[] } | null>(null)
  const [dialog, setDialog] = useState<{ open: boolean; cwd?: string; agentKey?: string; groupId?: string }>({ open: false })
  const [renaming, setRenaming] = useState<SessionView | null>(null)
  const [resumeFolder, setResumeFolder] = useState<string | null>(null)
  const [closing, setClosing] = useState<SessionData | null>(null)
  // Sessions shown in windows of their own: the main window shows a placeholder for them.
  const detached = useDetachedSessions()

  useEffect(() => {
    startStore()
    // Listening now: main reopens the sessions of the last run, whose resumed chats replay here.
    window.hub.sessions.ready()
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

  // In the profile's order, so the quick picker and New session agree on which agent comes first.
  const agents = useMemo(() => (agentList && agentList.profileId === activeProfileId ? orderAgents(profile?.preferredAgents, agentList.list) : []), [agentList, activeProfileId, profile?.preferredAgents])
  useEffect(() => {
    if (!snap) return
    // Replies can arrive out of order (A then B switched quickly): only the current request's reply applies.
    let alive = true
    window.hub.config.effectiveAgents(activeProfileId).then(
      (list) => alive && setAgentList({ profileId: activeProfileId, list }),
      () => alive && setAgentList({ profileId: activeProfileId, list: [] })
    )
    return () => {
      alive = false
    }
  }, [snap, activeProfileId])

  // The sidebar's folder browser: the profile's folders and the folders inside them, read again when they change.
  const [workspaces, setWorkspaces] = useState<WorkspaceFolder[]>([])
  const folderKey = JSON.stringify([profile?.folders ?? [], profile?.folderOptions ?? {}])
  useEffect(() => {
    let alive = true
    void window.hub.profileFolders(activeProfileId).then((list) => alive && setWorkspaces(list), () => alive && setWorkspaces([]))
    return () => {
      alive = false
    }
  }, [activeProfileId, folderKey])
  const projectFolders = useMemo(() => workspaces.map((w) => w.path), [workspaces])

  // A module turned off in the active profile takes its screen with it.
  useEffect(() => {
    if (snap && !reachable.some((i) => i.route === route)) setRoute('home')
  }, [snap, reachable, route])

  const sessions = useMemo(() => Object.values(sessionMap).sort((a, b) => b.view.startedAt - a.view.startedAt), [sessionMap])
  // A session in its own window is not mounted here too: one terminal per session, one size.
  const docked = useMemo(() => sessions.filter((s) => !detached.has(s.view.id)), [sessions, detached])

  const groups = snap?.config.sessionGroups ?? EMPTY_SESSION_GROUPS
  // The sessions as rows: a new array only when a row changes (a view, a flag, the prompt that names it),
  // not on every flush of a streaming reply. The tray and the group-member effects read these.
  const rowsRef = useRef(sessions)
  if (!sameRows(rowsRef.current, sessions)) rowsRef.current = sessions
  const rows = rowsRef.current
  const listed = useMemo(() => listSessions(rows), [rows])
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
        // The kind, then what the agent said (or asks, or failed with), so the notification says what happened.
        const detail = attentionDetail(data.items, kind)
        window.hub.notifications.show({ title: notificationTitle(sessionLabel(data), group?.name), body: detail ? `${tr(NOTIFY_BODY[kind])}: ${detail}` : tr(NOTIFY_BODY[kind]), sessionId: id, kind })
      }),
    []
  )
  // Usage alerts (Settings → Usage): a click opens Home, where "Usage by agent" is.
  const showScreen = useCallback((r: Route) => setRoute(r), [])
  useUsageAlerts(useCallback(() => showScreen('home'), [showScreen]))
  // Slack notices have no session: their click opens the Slack screen.
  useEffect(() => window.hub.notifications.onOpen((id) => (id ? openSession(id) : showScreen('slack'))), [openSession, showScreen])

  // Members remember their title, agent and folder so they can be listed (and reopened) once closed.
  useEffect(() => {
    if (!snap || snap.loadError) return
    const live = listed.map(memberOf)
    if (refreshMembers(groups, live) !== groups) void updateGroups((g) => refreshMembers(g, live), liveKeys)
  }, [snap, groups, listed, liveKeys])
  // Members saved without their name or account, and reopened sessions known only by their folder,
  // are looked up once in the session history (the agent's title, its first prompt, its account).
  const historyAsked = useRef(new Set<string>())
  const [pastTitles, setPastTitles] = useState<ReadonlyMap<string, string>>(new Map())
  useEffect(() => {
    if (!snap || snap.loadError) return
    const keys = historyLookupKeys(groups, listed, historyAsked.current)
    if (!keys.length) return
    for (const k of keys) historyAsked.current.add(k)
    void lookUpHistory(keys, liveKeys).then(
      (found) => found.size && setPastTitles((prev) => new Map([...prev, ...found])),
      () => undefined
    )
  }, [snap, groups, listed, liveKeys])
  const openPullRequest = useCallback((url?: string) => {
    setPrFocus(url ? { url } : null)
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
  // Settings opens in a window of its own, which can stay open beside this one. Old tab ids
  // ('trackers', 'accounts', 'profiles'…) open the section that now holds them (the window maps them);
  // `section#anchor` (the menu bar's `general#updates`) also points at one group of it.
  const openSettings = useCallback((tab?: string) => window.hub.settings.open(tab), [])
  // Every way to Settings (sidebar, ⌘,, the menu bar icon, links to a tab) opens the Settings window.
  const navigate = useCallback(
    (r: Route, tab?: string) => {
      if (r === 'settings') return openSettings(tab)
      if (r === 'sessions') setSelectedSession(null)
      showScreen(r)
    },
    [openSettings, showScreen]
  )
  // A meeting reminder without a call link was clicked: show Plan.
  useEffect(() => window.hub.plan.onFocus(() => navigate('plan')), [navigate])
  // The full dialog: pick the agent, account and folder (the toolbar's arrow, a sidebar folder row).
  const newSession = useCallback((cwd?: string | null, agentKey?: string) => setDialog({ open: true, cwd: cwd ?? undefined, agentKey }), [])
  // "New session" (toolbar button, ⌘T, the menus): the profile's preferred agent in its default
  // folder, without asking. The dialog opens instead when that cannot start (no agent, not installed, an error).
  const [home, setHome] = useState<string | undefined>()
  useEffect(() => void window.hub.getDefaultCwd().then(setHome, () => undefined), [])
  const quickPlan = quickSessionPlan(profile, agents, home)
  const quick = useRef({ profile, agents, home, activeProfileId })
  quick.current = { profile, agents, home, activeProfileId }
  // ⌘T reaches us as the native menu accelerator and as a key event; one burst starts one session.
  const quickGate = useRef(createQuickSessionGate())
  const quickSession = useCallback(
    async (agentKey?: string) => {
      const { profile: p, agents: list, home: h, activeProfileId: profileId } = quick.current
      const plan = quickSessionPlan(p, list, h, agentKey)
      const agent = list.find((a) => a.key === plan?.agentKey)
      const installed = agent ? await window.hub.agents.availability().then((m) => m[agent.agent.id] !== false, () => true) : false
      if (!plan || !installed) return newSession(null, agentKey)
      try {
        // The profile (or the folder) may start sessions in a worktree; a folder outside a repository starts as is.
        const worktree = worktreeDefault(p, plan.cwd, h) ? { worktree: { optional: true } } : {}
        const view = await window.hub.sessions.start({ profileId, agentKey: plan.agentKey, cwd: plan.cwd, cols: 100, rows: 30, ...worktree })
        openSession(view.id)
      } catch (e) {
        toast(errorText(e), 'danger')
        newSession(plan.cwd, plan.agentKey)
      }
    },
    [newSession, openSession, toast]
  )
  // The menu bar / notification area icon: it lists the sessions and opens screens and starts a new session.
  useTraySync({ sessions: rows, groups, locale, navigate, newSession: () => void quickSession() })

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
            if (!command.agentKey && !quickGate.current()) return
            return void quickSession(command.agentKey)
          case 'closeSession':
            if (current) {
              if (closeAsks(current.view, isWorking(current), currentConfig()?.config.profiles ?? [])) setClosing(current)
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
    [navigate, quickSession]
  )

  // CmdOrCtrl shortcuts for every nav item, plus CmdOrCtrl+T for a new session (Workhub 1's keys).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (matchesShortcut(e, NEW_SESSION_SHORTCUT, platform)) {
        e.preventDefault()
        if (quickGate.current()) void quickSession()
        return
      }
      if (matchesShortcut(e, SIDEBAR_SHORTCUT, platform)) {
        e.preventDefault()
        setPrefs({ sidebarHidden: !readPrefs().sidebarHidden })
        return
      }
      if (matchesShortcut(e, MONITOR_SHORTCUT, platform)) {
        e.preventDefault()
        setPrefs({ monitorHidden: !readPrefs().monitorHidden })
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
  }, [reachable, platform, navigate, quickSession])

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

  // A flow map window asked for a Claude session about its map.
  const investigateRef = useRef(investigate)
  investigateRef.current = investigate
  useEffect(() => window.hub.flowMaps.onAsk((draft, folder) => void investigateRef.current(draft, folder)), [])

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

  const layout = usePrefs()
  const selectProfile = async (id: string) => {
    const r = await window.hub.config.setActiveProfile(id)
    if (r.ok) await refreshConfig()
  }

  return (
    <div className="flex h-full">
      {!layout.sidebarHidden && (
        <Sidebar
          route={route}
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
              accounts={snap?.config.accounts}
              pastTitles={pastTitles}
              onOpenSlack={reachable.some((i) => i.route === 'slack') ? () => navigate('slack') : undefined}
              onRename={setRenaming}
              onOpenInWindow={(id) => window.hub.windows.openSession(id)}
              onNewSessionInGroup={(groupId) => setDialog({ open: true, groupId })}
            />
          }
          attentionCount={sessions.filter((s) => s.unseen).length}
          onDropOnSessions={(e) => dropOnSessionsTitle(e, liveKeys)}
          workspaces={workspaces}
          onNewSessionIn={(f) => (f ? newSession(f) : void quickSession())}
          onResumeIn={setResumeFolder}
          usage={usageGroups(sessions, accountUsage)}
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col bg-bg">
        <Toolbar
          nav={<TopNav items={navItems} route={route} onNavigate={navigate} profileId={activeProfileId} />}
          agents={agents}
          onNewSession={() => void quickSession()}
          onChooseSession={(key) => newSession(null, key)}
          newSessionHint={quickPlan ? t('toolbar.newSessionIn', { agent: quickPlan.agentLabel, folder: abbreviateFolder(quickPlan.cwd) }) : undefined}
          onOpenSettings={() => openSettings()}
          sidebarHidden={layout.sidebarHidden}
          onToggleSidebar={() => setPrefs({ sidebarHidden: !layout.sidebarHidden })}
        />
        <main className="relative min-h-0 flex-1">
          {/* Sessions stay mounted so terminals and chats survive a visit to another screen. */}
          <div className={route === 'sessions' ? 'relative h-full' : 'hidden'}>
            <SessionsScreen sessions={docked} selectedId={selectedSession} visible={route === 'sessions'} theme={theme} onNewSession={() => void quickSession()} />
            {selectedSession && detached.has(selectedSession) && <DetachedSessionNotice data={sessionMap[selectedSession]} />}
          </div>
          {kept.map((r) => (
            <div key={r} className={r === route ? SCREEN_PANE : 'hidden'}>
              {r === 'history' ? (
                <HistoryScreen profileId={activeProfileId} profiles={profiles} onOpened={openSession} visible={route === 'history'} />
              ) : (
                <PullRequestsScreen profile={profile} focus={prFocus} onOpenSettings={openSettings} visible={route === 'pullRequests'} />
              )}
            </div>
          ))}
          {route !== 'sessions' && route !== 'settings' && !KEPT_ROUTES.has(route) && (
            <div key={route} className={SCREEN_PANE}>
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
              ) : route === 'health' ? (
                <HealthScreen profile={profile} projectFolders={projectFolders} onOpenSettings={openSettings} onInvestigate={investigate} />
              ) : route === 'plan' ? (
                <PlanScreen profile={profile} onOpenSession={openSession} onOpenSettings={openSettings} />
              ) : route === 'flowMaps' ? (
                <FlowMapsScreen profile={profile} onOpenSettings={openSettings} onInvestigate={investigate} />
              ) : route === 'tickets' ? (
                <TicketsScreen profile={profile} sessions={sessions} onOpenSettings={openSettings} />
              ) : route === 'slack' ? (
                <SlackScreen profile={profile} sessions={sessions} onOpenSession={openSession} onOpenSettings={openSettings} />
              ) : route === 'automations' ? (
                <AutomationsScreen profile={profile} agents={agents} onOpenSession={openSession} />
              ) : null}
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
        initialCwd={dialog.cwd ?? profileDefaultFolder(profile, home)}
        folders={workspaces}
        profiles={profiles}
        initialAgentKey={dialog.agentKey}
        groups={groups}
        initialGroupId={dialog.groupId}
        onStarted={openSession}
      />
      <SubagentSheet />
      <RenameSessionDialog session={renaming} onClose={() => setRenaming(null)} />
      <UpdatePromptDialog />
      <ResumeSheet folder={resumeFolder} profileId={activeProfileId} onClose={() => setResumeFolder(null)} onOpened={openSession} />
      {closing && <CloseSessionDialog session={closing} working={isWorking(closing)} onDone={() => setClosing(null)} onError={(message) => toast(message, 'danger')} />}
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
