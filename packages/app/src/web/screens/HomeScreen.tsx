import { Bot, ChevronRight, FolderClosed, FolderOpen, Plus, RotateCcw, X } from 'lucide-react'
import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { accountColor, EMPTY_SESSION_GROUPS, memberAgentId, profileColor, sidebarRows, statusLevel, subtreeMembers, type GroupMember, type GroupRow, type StatusLevel, type SubagentSummary } from '@workhub/core'
import { useI18n } from '../../renderer/i18n/I18nProvider'
import { cn } from '../../renderer/lib/cn'
import { LEVEL_LABEL, LEVEL_TONE } from '../../renderer/lib/attention'
import { folderName } from '../../renderer/lib/home'
import { visibleSubagents } from '../../renderer/lib/subagentView'
import { useNow } from '../../renderer/lib/usage'
import { groupSummary, listSessions, memberOf, rowName, sessionNameInfo, type ListedSession } from '../../renderer/lib/sessionGroups'
import { Spinner } from '../../renderer/components/atoms'
import { AgentIcon } from '../../renderer/components/atoms/AgentIcon'
import { Badge } from '../../renderer/components/atoms/Badge'
import { STATE_TONE, StateDot } from '../../renderer/components/atoms/StateDot'
import { StatusGlyph } from '../../renderer/components/atoms/StatusGlyph'
import { awaitingAnswer, useSessions, type SessionData } from '../../renderer/store'
import { navigate, useClientStatus, useConfig, useProfileId } from '../app-context'
import { Body, DesktopPicker, Empty, Header, InlineConfirm, Screen } from '../ui'

/** As the desktop sidebar colours a row's state in its subtitle. */
const STATUS_TEXT: Record<StatusLevel, string> = { error: 'text-danger', needsAnswer: 'text-warning', readyToReview: 'text-success', working: 'text-info' }

/** Where the list was scrolled when a chat was opened, so coming back lands there again. */
let savedScroll = 0

/** A sub-agent under its session's row, as the desktop sidebar lists it; a tap opens its conversation. */
function SubagentRow({ sessionId, subagent: s, depth }: { sessionId: string; subagent: SubagentSummary; depth: number }) {
  const { t } = useI18n()
  const name = s.description ?? s.name ?? s.type ?? s.id
  const running = s.status === undefined || s.status === 'running' || s.status === 'background'
  const tone = s.status === 'failed' ? 'danger' : running ? 'info' : s.status === 'completed' ? 'success' : 'neutral'
  return (
    <li>
      <button
        type="button"
        data-testid="subagent-row"
        onClick={() => navigate({ screen: 'subagent', sessionId, id: s.id })}
        aria-label={t('subagent.open', { name })}
        className="flex w-full min-w-0 items-center gap-2 py-2 pr-4 text-left text-sm text-muted active:bg-surface-hover"
        style={{ paddingLeft: 48 + depth * 14 }}
      >
        <Bot className="size-4 shrink-0 text-subtle" aria-hidden />
        <StateDot tone={tone} pulse={running} />
        <span className="min-w-0 flex-1">
          <span className="block truncate">
            {s.type && <span className="font-medium text-text">{s.type}</span>}
            {s.type && s.description ? ' ' : ''}
            {s.description ?? (s.type ? '' : name)}
          </span>
          {s.lastStep && <span className="block truncate text-xs text-subtle">{s.lastStep}</span>}
        </span>
      </button>
    </li>
  )
}

/** The name the desktop's sidebar shows for a session. */
export function sessionTitle(s: SessionData): string {
  return sessionNameInfo(s).title
}

/**
 * The desktop sidebar on the phone, row for row: its order, its groups and sub-groups (folders),
 * each row with the agent's icon, the profile's colour bar, the account, folder and state, and the
 * glyph that says what it is up to (working, waiting on an answer, a reply to read, an error).
 * Closed members of groups are dimmed and a tap reopens them, as on the desktop.
 */
export function HomeScreen() {
  const { t, tn } = useI18n()
  const status = useClientStatus()
  const sessions = useSessions()
  const { config } = useConfig()
  const [closing, setClosing] = useState<string | null>(null)
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set())
  const [profileId] = useProfileId(config)
  const [reopening, setReopening] = useState<string | null>(null)
  const [reopenError, setReopenError] = useState<string | null>(null)
  const listed = useMemo(() => listSessions(Object.values(sessions).filter((s) => !s.view.readOnly)), [sessions])
  const groups = config?.config.sessionGroups ?? EMPTY_SESSION_GROUPS
  const rows = useMemo(() => sidebarRows(groups, listed), [groups, listed])
  const desktop = status.desktop?.name ?? ''
  const now = useNow(15_000)
  // Sessions whose sub-agents are listed: those working start open, and a tap flips any of them.
  const [flipped, setFlipped] = useState<ReadonlySet<string>>(new Set())
  const expanded = useMemo(() => {
    const open = new Set<string>()
    for (const l of listed) {
      const working = visibleSubagents(l.data.monitor.subagents, now).some((s) => s.status === undefined || s.status === 'running' || s.status === 'background')
      if (working !== flipped.has(l.key)) open.add(l.key)
    }
    return open
  }, [listed, flipped, now])
  const toggleSubagents = (key: string) =>
    setFlipped((prev) => {
      const next = new Set(prev)
      if (!next.delete(key)) next.add(key)
      return next
    })
  // The list comes back where it was after a chat; the scroller is the Body around this probe.
  const probe = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const el = probe.current?.parentElement
    if (!el) return
    el.scrollTop = savedScroll
    const onScroll = () => {
      savedScroll = el.scrollTop
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  const close = (id: string) => {
    setClosing(null)
    void window.hub.sessions.close(id).catch(() => {})
  }
  /** Opens a closed member again, as the desktop sidebar's Reopen does: resumed by its id when its agent can. */
  const reopen = async (member: GroupMember) => {
    setReopening(member.key)
    setReopenError(null)
    try {
      const memberProfile = member.profileId ?? profileId
      const agents = await window.hub.config.effectiveAgents(memberProfile)
      const choice = agents.find((a) => a.key === member.agentKey)
      if (!choice) throw new Error(member.agentName ?? member.agentKey)
      const resumes = choice.agent.adapter === 'native' || Boolean(choice.agent.console)
      const view = await window.hub.sessions.reopen(member.key, {
        profileId: memberProfile,
        agentKey: member.agentKey,
        cwd: member.cwd,
        mode: 'app',
        ...(resumes ? { resumeAgentSessionId: member.key } : { identity: member.key })
      })
      navigate({ screen: 'session', id: view.id })
    } catch (e) {
      setReopenError(t('groups.reopenFailed', { message: e instanceof Error ? e.message : String(e) }))
    } finally {
      setReopening(null)
    }
  }

  const profiles = config?.config.profiles ?? []
  const accounts = config?.config.accounts ?? []

  const toggle = (id: string) =>
    setToggled((prev) => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      return next
    })

  /** One row as the desktop sidebar draws it; `entry` is missing for a closed member. */
  const sessionItem = (member: GroupMember, entry: ListedSession | undefined, depth: number) => {
    const data = entry?.data
    const closed = !data
    const level = data ? statusLevel({ state: data.view.state, unseen: data.unseen, awaitingAnswer: awaitingAnswer(data) }) : null
    const tone = data ? (level ? LEVEL_TONE[level] : STATE_TONE[data.view.state]) : 'neutral'
    const stopped = data?.view.state === 'stopped'
    const status = data ? (data.unseen && level ? t(LEVEL_LABEL[level]) : t(`state.${data.view.state}`)) : t('groups.closed')
    const cwd = data ? data.view.cwd : member.cwd
    const agentId = data ? data.view.agentId : memberAgentId(member)
    const agentName = data?.view.agentName ?? member.agentName
    const accountId = data ? data.view.accountId : member.accountId
    const accountName = accounts.find((a) => a.id === accountId)?.name ?? (data ? data.view.accountName : member.accountName)
    const accountTint = accountColor(accounts, accountId)
    const profileTint = profileColor(profiles, data?.view.profileId ?? member.profileId)
    const title = rowName(entry, member)
    // Its sub-agents at work, and those that ended a few minutes ago, as the desktop lists them.
    const subagents = data ? visibleSubagents(data.monitor.subagents, now) : []
    const subagentsOpen = expanded.has(member.key)
    const open = () => (data ? navigate({ screen: 'session', id: data.view.id }) : void reopen(member))
    if (data && closing === data.view.id) {
      return (
        <li key={member.key} className="px-4 py-2">
          <InlineConfirm question={t('web.home.closeConfirm')} yes={t('web.home.closeYes')} onYes={() => close(data.view.id)} onNo={() => setClosing(null)} danger />
        </li>
      )
    }
    return (
      <li key={member.key}>
        <div className={cn('relative flex items-center active:bg-surface-hover', (closed || stopped) && 'opacity-60')} data-testid={closed ? 'closed-member' : 'session-row'}>
          {profileTint && <span aria-hidden style={{ backgroundColor: profileTint }} className="absolute inset-y-1.5 w-1 rounded-full" />}
          <button
            type="button"
            onClick={open}
            disabled={closed && reopening !== null}
            className="flex min-w-0 flex-1 items-center gap-3 py-2.5 pr-2 text-left"
            style={{ paddingLeft: 14 + depth * 14 }}
          >
            <span className="relative inline-flex shrink-0">
              <AgentIcon
                agentId={agentId}
                adapter={data?.view.adapter}
                label={agentName}
                className={accountTint ? 'ring-2 ring-offset-1 ring-offset-bg' : undefined}
                style={accountTint ? ({ '--tw-ring-color': accountTint } as CSSProperties) : undefined}
              />
              {closed ? (
                reopening === member.key ? (
                  <Spinner className="absolute -right-1 -bottom-1 size-3.5" />
                ) : (
                  <RotateCcw className="absolute -right-1 -bottom-1 size-3.5 rounded-full bg-surface text-subtle" aria-hidden />
                )
              ) : (
                // Wrapped: StateDot sets `relative` itself, and `cn` does not merge a second position class away.
                <span className="absolute -right-0.5 -bottom-0.5 inline-flex rounded-full ring-2 ring-bg">
                  <StateDot tone={tone} />
                </span>
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className={cn('block truncate text-md', data?.unseen ? 'font-semibold text-text' : 'text-text')}>{title}</span>
              <span className="block truncate text-xs text-subtle">
                {accountName && (
                  <>
                    <span className="font-medium" style={accountTint ? { color: accountTint } : undefined}>
                      {accountName}
                    </span>
                    {' · '}
                  </>
                )}
                {folderName(cwd)} · <span className={cn(level && STATUS_TEXT[level])}>{closed ? t('groups.reopen') : status}</span>
              </span>
            </span>
            {level && <StatusGlyph level={level} label={t(LEVEL_LABEL[level])} className="[&_svg]:size-4" />}
          </button>
          {subagents.length > 0 && (
            <button
              type="button"
              data-testid="subagents-toggle"
              aria-expanded={subagentsOpen}
              aria-label={tn(subagentsOpen ? 'sidebar.subagents.hide' : 'sidebar.subagents.show', subagents.length)}
              onClick={() => toggleSubagents(member.key)}
              className="flex h-9 shrink-0 items-center gap-0.5 rounded-lg px-1.5 text-xs text-subtle tabular-nums active:bg-surface-hover"
            >
              <ChevronRight className={cn('size-3.5 transition-transform', subagentsOpen && 'rotate-90')} aria-hidden />
              <Bot className="size-3.5" aria-hidden />
              {subagents.length}
            </button>
          )}
          {data && (
            <button
              type="button"
              aria-label={t('web.close')}
              onClick={() => setClosing(data.view.id)}
              className="mr-2 flex size-9 shrink-0 items-center justify-center rounded-lg text-subtle active:bg-surface-hover"
            >
              <X className="size-4" aria-hidden />
            </button>
          )}
        </div>
        {data && subagentsOpen && subagents.length > 0 && (
          <ul aria-label={tn('sidebar.subagents.list', subagents.length, { name: title })}>
            {subagents.map((s) => (
              <SubagentRow key={s.id} sessionId={data.view.id} subagent={s} depth={depth} />
            ))}
          </ul>
        )}
      </li>
    )
  }

  const groupItem = (row: GroupRow<ListedSession>): ReactNode => {
    const all = subtreeMembers(row)
    const summary = groupSummary(all)
    // The desktop's collapsed state is the starting point; a tap here only changes the phone.
    const collapsed = row.group.collapsed !== toggled.has(row.group.id)
    const Icon = collapsed ? FolderClosed : FolderOpen
    return (
      <li key={`g:${row.group.id}`} data-testid="group">
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={() => toggle(row.group.id)}
          className="flex h-11 w-full items-center gap-2 pr-4 text-left text-muted active:bg-surface-hover"
          style={{ paddingLeft: 12 + row.depth * 14 }}
        >
          <ChevronRight className={cn('size-4 shrink-0 text-subtle transition-transform', !collapsed && 'rotate-90')} aria-hidden />
          <Icon className="size-4 shrink-0 text-subtle" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-md font-medium">{row.group.name}</span>
          {summary.count > 0 && <Badge tone={summary.level && summary.level !== 'working' ? LEVEL_TONE[summary.level] : 'accent'}>{summary.count}</Badge>}
          {summary.level && <StateDot tone={LEVEL_TONE[summary.level]} pulse={summary.level === 'working'} />}
        </button>
        {!collapsed && (row.children.length > 0 || row.members.length > 0) && (
          <ul className="relative pb-1">
            {/* The guide line the desktop draws down an open group, under its chevron. */}
            <span aria-hidden className="absolute inset-y-0 w-px bg-border" style={{ left: 19 + row.depth * 14 }} />
            {row.children.map(groupItem)}
            {row.members.map((m) => sessionItem(m.member, m.session, row.depth + 1))}
          </ul>
        )}
      </li>
    )
  }

  return (
    <Screen>
      <Header
        title={t('web.home.title')}
        subtitle={status.desktops.length > 1 ? <DesktopPicker /> : status.state === 'online' ? t('web.state.online', { desktop }) : t('web.home.offlineCache')}
        right={
          <button type="button" onClick={() => navigate({ screen: 'new' })} className="flex h-9 items-center gap-1 rounded-full bg-accent pr-3.5 pl-2.5 text-sm font-semibold text-accent-fg">
            <Plus className="size-4" aria-hidden />
            {t('web.home.new')}
          </button>
        }
      />
      <Body>
        <span ref={probe} hidden />
        {reopenError && <p className="mx-4 mt-3 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{reopenError}</p>}
        {rows.length === 0 ? (
          <Empty title={t('web.home.empty', { desktop })} hint={t('web.home.emptyHint')} />
        ) : (
          <ul className="py-1">{rows.map((row) => (row.type === 'session' ? sessionItem(memberOf(row.session), row.session, 0) : groupItem(row)))}</ul>
        )}
      </Body>
    </Screen>
  )
}
