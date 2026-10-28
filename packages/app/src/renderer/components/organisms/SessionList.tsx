import { Bot, ChevronRight, Ellipsis, FolderClosed, FolderOpen, FolderPlus, RotateCcw, Settings, X } from 'lucide-react'
import { ContextMenu, DropdownMenu } from 'radix-ui'
import { memo, useMemo, useRef, useState, type CSSProperties, type DragEvent, type ElementType, type KeyboardEvent, type ReactNode } from 'react'
import {
  accountColor,
  createGroup,
  deleteGroup,
  groupOf,
  memberAgentId,
  moveBy,
  moveGroupBy,
  moveGroupOnto,
  moveOnto,
  moveToGroup,
  profileColor,
  reconcileTop,
  removeMember,
  renameGroup,
  setGroupCollapsed,
  sidebarRows,
  statusLevel,
  ungroup,
  type AgentAccount,
  type GroupMember,
  type Profile,
  type SessionGroup,
  type SessionGroups,
  type StatusLevel,
  type SubagentSummary,
  type TopSlot
} from '@workhub/core'
import { useI18n } from '../../i18n/I18nProvider'
import { LEVEL_LABEL, LEVEL_TONE } from '../../lib/attention'
import { cn } from '../../lib/cn'
import { folderName } from '../../lib/home'
import { groupSummary, listSessions, memberOf, newGroupId, rowName, summarize, updateGroups, type ListedSession } from '../../lib/sessionGroups'
import { openSubagent, visibleSubagents } from '../../lib/subagentView'
import { useNow } from '../../lib/usage'
import { usePlatform } from '../../lib/platform'
import { shortcutLabel } from '../../lib/shortcuts'
import { isSessionReadAloud, setSessionReadAloud, useReadAloudVersion } from '../../lib/readAloud'
import { useAutomations } from '../../chatStore'
import { awaitingAnswer, pushItem } from '../../store'
import { AgentIcon } from '../atoms/AgentIcon'
import { Badge } from '../atoms/Badge'
import { Button } from '../atoms/Button'
import { Input } from '../atoms/Input'
import { Tooltip } from '../atoms/Tooltip'
import { STATE_TONE, StateDot } from '../atoms/StateDot'
import { StatusGlyph } from '../atoms/StatusGlyph'
import { Dialog } from '../molecules/Dialog'
import { SlackBadge } from '../molecules/SlackBadge'
import { useSessionSlack } from '../../lib/slackLinks'
import { Field } from '../molecules/Field'
import type { SessionData } from '../../store'
import { errorText } from '../../lib/errorText'

export const SESSION_DRAG = 'application/x-workhub-session'

/** Whether closing the session would cut work off: a turn runs, it is starting, or it waits on an answer. */
export function isWorking(data: SessionData): boolean {
  return data.view.state === 'busy' || data.view.state === 'starting' || awaitingAnswer(data)
}
export const GROUP_DRAG = 'application/x-workhub-group'

export interface SessionListProps {
  sessions: SessionData[]
  groups: SessionGroups
  selectedId: string | null
  /** Whether the Sessions screen is up: the selected row is only highlighted then. */
  active: boolean
  onSelect: (id: string) => void
  /** Opens a closed member again (resumes it, or starts it fresh when the agent cannot resume). */
  onReopen: (member: GroupMember) => void
  /** The profiles: each session row carries its profile's colour down its left edge. */
  profiles?: readonly Pick<Profile, 'id' | 'name' | 'color'>[]
  /** The agent accounts: a row names its account and marks it with the account's colour. */
  accounts?: readonly Pick<AgentAccount, 'id' | 'agentId' | 'name'>[]
  /** History titles of reopened sessions outside any group, by identity (see `lookUpHistory`). */
  pastTitles?: ReadonlyMap<string, string>
  /** The Slack badge of a row that owns followed threads opens the Slack screen. */
  onOpenSlack?: () => void
  /** "Rename…" of an open session. */
  onRename?: (view: SessionData['view']) => void
  /** "Open in New Window" of an open session. */
  onOpenInWindow?: (id: string) => void
}

type MenuItem = { label: string; hint?: string; onSelect: () => void } | { separator: true } | { label: string; items: MenuItem[] }

type Dialogs = { kind: 'create'; member?: GroupMember } | { kind: 'rename'; group: SessionGroup } | { kind: 'delete'; group: SessionGroup } | null

const MENU_CONTENT = 'z-50 min-w-48 animate-fade-in rounded-md border border-border bg-surface-raised p-1 shadow-lg'
const MENU_ITEM = 'flex h-8 cursor-default select-none items-center justify-between gap-6 rounded-sm px-2 text-base outline-none data-[highlighted]:bg-accent-soft'

/** The primitives the context menu (right click, Menu key) and the options button share. */
interface MenuKit {
  Portal: ElementType
  Content: ElementType
  Item: ElementType
  Separator: ElementType
  Sub: ElementType
  SubTrigger: ElementType
  SubContent: ElementType
}

/**
 * A menu's items, built when the menu opens: Radix mounts a menu's content only while it is open,
 * so rows do not build (or rebuild on every render) menus nobody opened.
 */
function MenuItems({ kit, build }: { kit: MenuKit; build: () => MenuItem[] }) {
  return <>{renderMenu(kit, build())}</>
}

function renderMenu(kit: MenuKit, items: MenuItem[]): ReactNode {
  return items.map((item, i) => {
    if ('separator' in item) return <kit.Separator key={i} className="my-1 h-px bg-border" />
    if ('items' in item) {
      return (
        <kit.Sub key={item.label}>
          <kit.SubTrigger className={MENU_ITEM}>
            {item.label}
            <ChevronRight className="size-3.5 text-subtle" aria-hidden />
          </kit.SubTrigger>
          <kit.Portal>
            <kit.SubContent className={MENU_CONTENT}>{renderMenu(kit, item.items)}</kit.SubContent>
          </kit.Portal>
        </kit.Sub>
      )
    }
    return (
      <kit.Item key={item.label} className={MENU_ITEM} onSelect={item.onSelect}>
        {item.label}
        {item.hint && <span className="text-xs text-subtle">{item.hint}</span>}
      </kit.Item>
    )
  })
}

function hasType(e: DragEvent, type: string): boolean {
  return Array.from(e.dataTransfer.types).includes(type)
}

function readMember(e: DragEvent): GroupMember | null {
  try {
    const m = JSON.parse(e.dataTransfer.getData(SESSION_DRAG)) as GroupMember
    return typeof m.key === 'string' ? m : null
  } catch {
    return null
  }
}

/**
 * The Sessions section of the sidebar: ungrouped sessions and groups, interleaved in the order
 * the user arranged them. Groups hold sessions by their stable identity, so a closed session
 * stays listed (dimmed, reopenable) until it is removed.
 */
export function SessionList({ sessions, groups, selectedId, active, onSelect, onReopen, profiles = [], accounts = [], pastTitles, onOpenSlack, onRename, onOpenInWindow }: SessionListProps) {
  const { t, tn } = useI18n()
  const platform = usePlatform()
  const listed = useMemo(() => listSessions(sessions), [sessions])
  const liveKeys = useMemo(() => listed.map((s) => s.key), [listed])
  const rows = useMemo(() => sidebarRows(groups, listed), [groups, listed])
  const state = useMemo(() => reconcileTop(groups, liveKeys), [groups, liveKeys])
  const [dialog, setDialog] = useState<Dialogs>(null)
  const [over, setOver] = useState<string | null>(null)
  const [closing, setClosing] = useState<SessionData | null>(null)
  // Sessions whose sub-agents are listed under them; the clock lets ended ones drop out.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const now = useNow(15_000)
  const toggleSubagents = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (!next.delete(key)) next.add(key)
      return next
    })

  const act = (change: (s: SessionGroups) => SessionGroups) => void updateGroups(change, liveKeys)
  const live = useMemo(() => new Set(liveKeys), [liveKeys])

  const closeNow = (data: SessionData) =>
    void window.hub.sessions.close(data.view.id).catch((e: unknown) => pushItem(data.view.id, 'error', t('sessions.closeFailed', { message: errorText(e) })))
  /** Stops the session and drops it from the open sessions; a working one asks first. */
  const requestClose = (data: SessionData) => (isWorking(data) ? setClosing(data) : closeNow(data))

  // The menu reads the per-session read-aloud switches; a change re-renders it.
  useReadAloudVersion()
  const sessionMenu = (member: GroupMember): MenuItem[] => {
    const inGroup = groupOf(state, member.key)
    const isLive = live.has(member.key)
    const entry = listed.find((l) => l.key === member.key)
    const items: MenuItem[] = []
    if (!entry || entry.data.view.state === 'stopped') items.push({ label: t('groups.reopen'), onSelect: () => onReopen(member) }, { separator: true })
    if (entry && onRename) items.push({ label: t('session.rename'), onSelect: () => onRename(entry.data.view) })
    if (entry && onOpenInWindow && entry.data.view.state !== 'stopped') items.push({ label: t('window.openInNew'), hint: shortcutLabel({ key: 'n', shift: true }, platform), onSelect: () => onOpenInWindow(entry.data.view.id) })
    if (entry) items.push({ label: t('sessions.close'), onSelect: () => requestClose(entry.data) }, { separator: true })
    if (entry && entry.data.view.state !== 'stopped') {
      const reading = isSessionReadAloud(entry.data.view.id)
      items.push({ label: reading ? t('voice.session.on') : t('voice.session.off'), onSelect: () => setSessionReadAloud(entry.data.view.id, !reading) }, { separator: true })
    }
    items.push(
      { label: t('groups.moveUp'), hint: 'Alt+↑', onSelect: () => act((s) => moveBy(s, member.key, -1)) },
      { label: t('groups.moveDown'), hint: 'Alt+↓', onSelect: () => act((s) => moveBy(s, member.key, 1)) },
      {
        label: t('groups.moveTo'),
        items: [
          ...state.groups.filter((g) => g.id !== inGroup?.id).map((g): MenuItem => ({ label: g.name, onSelect: () => act((s) => moveToGroup(s, member, g.id)) })),
          ...(state.groups.some((g) => g.id !== inGroup?.id) ? [{ separator: true } as MenuItem] : []),
          { label: t('groups.moveToNew'), onSelect: () => setDialog({ kind: 'create', member }) }
        ]
      }
    )
    if (inGroup) {
      items.push({ separator: true })
      if (isLive) items.push({ label: t('groups.ungroup'), onSelect: () => act((s) => ungroup(s, member.key)) })
      if (!entry || entry.data.view.state === 'stopped') items.push({ label: t('groups.forget'), onSelect: () => act((s) => removeMember(s, member.key)) })
    }
    return items
  }

  const groupMenu = (group: SessionGroup): MenuItem[] => [
    { label: t('groups.rename'), onSelect: () => setDialog({ kind: 'rename', group }) },
    { label: t('groups.moveUp'), hint: 'Alt+↑', onSelect: () => act((s) => moveGroupBy(s, group.id, -1)) },
    { label: t('groups.moveDown'), hint: 'Alt+↓', onSelect: () => act((s) => moveGroupBy(s, group.id, 1)) },
    { separator: true },
    { label: t('groups.delete'), onSelect: () => setDialog({ kind: 'delete', group }) }
  ]

  const onDropOnSession = (e: DragEvent, targetKey: string) => {
    setOver(null)
    const group = groupOf(state, targetKey)
    if (hasType(e, GROUP_DRAG)) {
      e.preventDefault()
      const id = e.dataTransfer.getData(GROUP_DRAG)
      const target: TopSlot = group ? { kind: 'group', id: group.id } : { kind: 'session', key: targetKey }
      act((s) => moveGroupOnto(s, id, target))
    } else if (hasType(e, SESSION_DRAG)) {
      e.preventDefault()
      const member = readMember(e)
      if (member) act((s) => moveOnto(s, member, targetKey))
    }
  }

  const onDropOnGroup = (e: DragEvent, group: SessionGroup) => {
    setOver(null)
    if (hasType(e, GROUP_DRAG)) {
      e.preventDefault()
      const id = e.dataTransfer.getData(GROUP_DRAG)
      act((s) => moveGroupOnto(s, id, { kind: 'group', id: group.id }))
    } else if (hasType(e, SESSION_DRAG)) {
      e.preventDefault()
      const member = readMember(e)
      if (member) act((s) => moveToGroup(s, member, group.id))
    }
  }

  /** dragover must be cancelled for the element to accept a drop. */
  const accept = (e: DragEvent, id: string, types: string[]) => {
    if (!types.some((type) => hasType(e, type))) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (over !== id) setOver(id)
  }

  const profileOf = (member: GroupMember, entry: ListedSession | undefined) => {
    const id = entry?.data.view.profileId ?? member.profileId
    const color = profileColor(profiles, id)
    const name = profiles.find((p) => p.id === id)?.name
    return color && name ? { color, name } : undefined
  }

  /** The account a row runs with, named as Settings names it now, else as remembered. */
  const accountOf = (member: GroupMember, entry: ListedSession | undefined) => {
    const id = entry ? entry.data.view.accountId : member.accountId
    const name = accounts.find((a) => a.id === id)?.name ?? (entry ? entry.data.view.accountName : member.accountName)
    return name ? { name, color: accountColor(accounts, id) } : undefined
  }

  // What a row does, read from this render when it happens: the rows get one object that never
  // changes, so a row whose own data did not change is not rendered again (see `sameRow`).
  const entryOf = (key: string) => listed.find((l) => l.key === key)
  const latest = useRef({ sessionMenu, entryOf, onSelect, onReopen, onOpenSlack, requestClose, act, accept, setOver, onDropOnSession, toggleSubagents })
  latest.current = { sessionMenu, entryOf, onSelect, onReopen, onOpenSlack, requestClose, act, accept, setOver, onDropOnSession, toggleSubagents }
  const actions = useMemo<RowActions>(
    () => ({
      menu: (member) => latest.current.sessionMenu(member),
      open: (member) => {
        const entry = latest.current.entryOf(member.key)
        if (entry) latest.current.onSelect(entry.data.view.id)
        else latest.current.onReopen(member)
      },
      close: (key) => {
        const entry = latest.current.entryOf(key)
        if (entry) latest.current.requestClose(entry.data)
      },
      move: (key, step) => latest.current.act((s) => moveBy(s, key, step)),
      toggleSubagents: (key) => latest.current.toggleSubagents(key),
      openSubagent: (key, subagentId) => {
        const entry = latest.current.entryOf(key)
        if (!entry) return
        latest.current.onSelect(entry.data.view.id)
        openSubagent(entry.data.view.id, subagentId)
      },
      openSlack: () => latest.current.onOpenSlack?.(),
      dragOver: (e, key) => latest.current.accept(e, `s:${key}`, [SESSION_DRAG, GROUP_DRAG]),
      dragLeave: () => latest.current.setOver(null),
      drop: (e, key) => latest.current.onDropOnSession(e, key)
    }),
    []
  )

  const sessionItem = (member: GroupMember, entry: ListedSession | undefined, nested: boolean) => (
    <SessionItem
      key={member.key}
      actions={actions}
      slack={onOpenSlack !== undefined}
      member={member}
      title={rowName(entry, member, pastTitles?.get(member.key))}
      account={accountOf(member, entry)}
      profile={profileOf(member, entry)}
      subagents={entry ? visibleSubagents(entry.data.monitor.subagents, now) : NO_SUBAGENTS}
      subagentsOpen={expanded.has(member.key)}
      entry={entry}
      nested={nested}
      selected={active && entry !== undefined && selectedId === entry.data.view.id}
      dropping={over === `s:${member.key}`}
    />
  )

  return (
    <div data-testid="session-list">
      <ul className="mt-0.5 flex flex-col gap-0.5" aria-label={t('sidebar.sessionList')}>
        {rows.map((row) => {
          if (row.type === 'session') return sessionItem(memberOf(row.session), row.session, false)
          const { group } = row
          const summary = groupSummary(row.members)
          const selectedInside = active && row.members.some((m) => m.session !== undefined && m.session.data.view.id === selectedId)
          return (
            <li key={group.id} data-testid="group" data-group={group.name} data-attention={summary.count || undefined}>
              <GroupHeader
                group={group}
                summary={summary}
                selectedInside={selectedInside}
                dropping={over === `g:${group.id}`}
                menu={() => groupMenu(group)}
                // Flipped on the stored state, not this render's: quick clicks each count while a save is on its way.
                onToggle={() => act((s) => setGroupCollapsed(s, group.id, !s.groups.find((g) => g.id === group.id)?.collapsed))}
                onMove={(step) => act((s) => moveGroupBy(s, group.id, step))}
                onDragOver={(e) => accept(e, `g:${group.id}`, [SESSION_DRAG, GROUP_DRAG])}
                onDragLeave={() => setOver(null)}
                onDrop={(e) => onDropOnGroup(e, group)}
              />
              {!group.collapsed && row.members.length > 0 && (
                <ul className="mt-0.5 ml-3 flex flex-col gap-0.5 border-l border-border pl-1" aria-label={group.name}>
                  {row.members.map((m) => sessionItem(m.member, m.session, true))}
                </ul>
              )}
            </li>
          )
        })}
      </ul>
      <Button
        variant="ghost"
        size="sm"
        className="mt-1 w-full justify-start px-2.5 text-subtle"
        icon={<FolderPlus className="size-3.5" aria-hidden />}
        data-testid="new-group"
        onClick={() => setDialog({ kind: 'create' })}
      >
        {t('groups.new')}
      </Button>
      {closing && (
        <Dialog
          open
          onOpenChange={(o) => !o && setClosing(null)}
          title={t('sessions.closeTitle', { name: closing.view.agentName })}
          description={t('sessions.closeBody')}
          footer={
            <>
              <Button variant="ghost" onClick={() => setClosing(null)}>
                {t('common.cancel')}
              </Button>
              <Button
                variant="danger"
                data-testid="confirm-close-session"
                onClick={() => {
                  closeNow(closing)
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
      <GroupDialog
        dialog={dialog}
        closedLost={dialog?.kind === 'delete' ? dialog.group.members.filter((m) => !live.has(m.key)).length : 0}
        onClose={() => setDialog(null)}
        onCreate={(name, member) => act((s) => createGroup(s, newGroupId(), name, member))}
        onRename={(id, name) => act((s) => renameGroup(s, id, name))}
        onDelete={(id) => act((s) => deleteGroup(s, id, live))}
      />
      <span className="sr-only">{tn('groups.members', listed.length)}</span>
    </div>
  )
}

/** Dropping on the Sessions title takes a session out of its group, to the top of the list. */
export function dropOnSessionsTitle(e: DragEvent, liveKeys: readonly string[]): void {
  if (!hasType(e, SESSION_DRAG)) return
  e.preventDefault()
  const member = readMember(e)
  if (member) void updateGroups((s) => ungroup(s, member.key, 0), liveKeys)
}

/** What a session row does; one object for every row, stable across renders (see `SessionList`). */
interface RowActions {
  menu(member: GroupMember): MenuItem[]
  /** Shows the open session, or reopens a closed member. */
  open(member: GroupMember): void
  close(key: string): void
  move(key: string, step: -1 | 1): void
  toggleSubagents(key: string): void
  openSubagent(key: string, subagentId: string): void
  openSlack(): void
  dragOver(e: DragEvent, key: string): void
  dragLeave(): void
  drop(e: DragEvent, key: string): void
}

const NO_SUBAGENTS: SubagentSummary[] = []

interface SessionItemProps {
  member: GroupMember
  entry: ListedSession | undefined
  /** The row's name (see `rowName`). */
  title: string
  /** The account it runs with, and that account's colour when it is still set up. */
  account?: { name: string; color?: string }
  /** The session's profile, for the colour bar down the row's left edge. */
  profile?: { color: string; name: string }
  /** Its sub-agents at work or recently ended, listed under the row while `subagentsOpen`. */
  subagents: SubagentSummary[]
  subagentsOpen: boolean
  nested: boolean
  selected: boolean
  dropping: boolean
  /** Whether the Slack badge opens the Slack screen (the module is on). */
  slack: boolean
  actions: RowActions
}

const sameFields = <T extends object>(a: T | undefined, b: T | undefined): boolean => {
  if (a === b) return true
  if (!a || !b) return false
  const keys = Object.keys(a) as (keyof T)[]
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k])
}

/**
 * Whether a row would render the same: its member and session data, by value or reference. The
 * sidebar is rendered again on every config refresh (a group folded, a session renamed), and with
 * hundreds of rows, each with its menus and tooltips, rendering them all made each click slow.
 */
export function sameRow(a: SessionItemProps, b: SessionItemProps): boolean {
  return (
    sameFields(a.member, b.member) &&
    a.entry?.key === b.entry?.key &&
    a.entry?.data === b.entry?.data &&
    a.title === b.title &&
    sameFields(a.account, b.account) &&
    sameFields(a.profile, b.profile) &&
    a.subagents.length === b.subagents.length &&
    a.subagents.every((s, i) => s === b.subagents[i]) &&
    a.subagentsOpen === b.subagentsOpen &&
    a.nested === b.nested &&
    a.selected === b.selected &&
    a.dropping === b.dropping &&
    a.slack === b.slack &&
    a.actions === b.actions
  )
}

const SessionItem = memo(function SessionItem(props: SessionItemProps) {
  const { t, tn } = useI18n()
  const { member, entry, actions } = props
  // Threads this session owns (member.key is its stable identity), with a dot for unread replies.
  const slack = useSessionSlack(member.key)
  const data = entry?.data
  const level = data ? statusLevel({ state: data.view.state, unseen: data.unseen, awaitingAnswer: awaitingAnswer(data) }) : null
  const tone = data ? (level ? LEVEL_TONE[level] : STATE_TONE[data.view.state]) : 'neutral'
  const closed = !data
  const automation = useAutomations()?.automations.find((a) => a.session === member.key)?.definition.name
  // A session that was stopped is as good as closed: dimmed, and the row reopens it.
  const stopped = data?.view.state === 'stopped'
  const status = data ? (data.unseen && level ? t(LEVEL_LABEL[level]) : t(`state.${data.view.state}`)) : t('groups.closed')
  const { title, account } = props
  const cwd = data ? data.view.cwd : member.cwd
  const agentId = data ? data.view.agentId : memberAgentId(member)
  const agentName = data?.view.agentName ?? member.agentName
  const onKey = (e: KeyboardEvent) => {
    // Delete or Backspace closes the focused session, as the close button does.
    if (entry && !e.altKey && !e.metaKey && !e.ctrlKey && (e.key === 'Delete' || e.key === 'Backspace')) {
      e.preventDefault()
      actions.close(member.key)
      return
    }
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
    e.preventDefault()
    actions.move(member.key, e.key === 'ArrowUp' ? -1 : 1)
  }
  const menu = () => actions.menu(member)
  return (
    <li>
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>
          <div
            draggable
            data-testid={closed ? 'closed-member' : 'session-row'}
            data-key={member.key}
            data-unseen={data?.unseen}
            data-profile={props.profile?.name}
            onDragStart={(e) => {
              e.dataTransfer.setData(SESSION_DRAG, JSON.stringify(member))
              e.dataTransfer.effectAllowed = 'move'
            }}
            onDragOver={(e) => actions.dragOver(e, member.key)}
            onDragLeave={actions.dragLeave}
            onDrop={(e) => actions.drop(e, member.key)}
            className={cn(
              'group/row relative flex items-center rounded-md transition-colors duration-150',
              props.selected ? SELECTED_ROW : 'text-muted hover:bg-surface-hover hover:text-text',
              props.dropping && 'ring-2 ring-accent/60',
              (closed || stopped) && 'opacity-60'
            )}
          >
            {props.profile && (
              <Tooltip side="right" content={t('sidebar.profileBar', { name: props.profile.name })}>
                <span
                  data-testid="profile-bar"
                  role="img"
                  aria-label={t('sidebar.profileBar', { name: props.profile.name })}
                  style={{ backgroundColor: props.profile.color }}
                  className="absolute inset-y-1 left-0.5 w-1 rounded-full"
                />
              </Tooltip>
            )}
            <Tooltip
              side="right"
              content={
                <span data-testid="row-tooltip" className="block max-w-xs break-words">
                  <span className="block font-medium">{title}</span>
                  <span className="block text-xs text-muted">{agentName ?? agentId}</span>
                  {account && (
                    <span className="flex items-center gap-1.5 text-xs text-muted">
                      <span className="size-2 shrink-0 rounded-full bg-subtle" style={account.color ? { backgroundColor: account.color } : undefined} aria-hidden />
                      {t('sidebar.account', { name: account.name })}
                    </span>
                  )}
                  {props.profile && (
                    <span className="flex items-center gap-1.5 text-xs text-muted">
                      <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: props.profile.color }} aria-hidden />
                      {t('sidebar.profileBar', { name: props.profile.name })}
                    </span>
                  )}
                  <span className="block text-xs text-subtle">{cwd}</span>
                  <span className="block text-xs text-muted">{status}</span>
                  {closed && <span className="block text-xs font-medium text-text">{t('sidebar.clickToReopen')}</span>}
                </span>
              }
            >
              <button
                type="button"
                onClick={() => actions.open(member)}
                onKeyDown={onKey}
                aria-current={props.selected ? 'true' : undefined}
                className={cn('flex min-w-0 flex-1 items-center gap-2.5 rounded-md py-1.5 pr-1 text-left', props.nested ? 'pl-2' : 'pl-3')}
              >
                <span className="relative inline-flex shrink-0">
                  <AgentIcon
                    agentId={agentId}
                    adapter={data?.view.adapter}
                    label={agentName}
                    className={account?.color ? 'ring-2 ring-offset-1 ring-offset-sidebar' : undefined}
                    style={account?.color ? ({ '--tw-ring-color': account.color } as CSSProperties) : undefined}
                  />
                  {/* The dot says the agent's own state (ready, starting, stopped); the glyph at the right says what it is up to. */}
                  {closed ? (
                    <RotateCcw className="absolute -right-1 -bottom-1 size-3 rounded-full bg-surface text-subtle" aria-hidden />
                  ) : (
                    <StateDot tone={tone} className="absolute -right-0.5 -bottom-0.5 rounded-full ring-2 ring-sidebar" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={cn('block truncate text-base', (data?.unseen || props.selected) && 'font-semibold text-text')}>{title}</span>
                  <span className={cn('block truncate text-xs', props.selected ? 'text-muted' : 'text-subtle')} data-testid="row-subtitle">
                    {account && (
                      <>
                        <span data-testid="row-account" className="font-medium" style={account.color ? { color: account.color } : undefined}>
                          {account.name}
                        </span>
                        {' · '}
                      </>
                    )}
                    {folderName(cwd)} · <span className={cn(level && STATUS_TEXT[level])}>{status}</span>
                  </span>
                </span>
                {automation && <Settings data-testid="automation-badge" role="img" aria-label={t('automations.sessionBadge', { name: automation })} className="size-3.5 shrink-0 text-subtle" />}
                {/* Working, waiting on an answer, a reply to read or an error: a glyph that tells them apart at a glance. */}
                {level && <StatusGlyph level={level} label={t(LEVEL_LABEL[level])} data-testid="status-glyph" data-unseen={data?.unseen} className="mr-0.5" />}
              </button>
            </Tooltip>
            {props.slack && <SlackBadge summary={slack.summary} onOpen={actions.openSlack} />}
            {props.subagents.length > 0 && (
              <button
                type="button"
                data-testid="subagents-toggle"
                aria-expanded={props.subagentsOpen}
                aria-label={tn(props.subagentsOpen ? 'sidebar.subagents.hide' : 'sidebar.subagents.show', props.subagents.length)}
                title={tn(props.subagentsOpen ? 'sidebar.subagents.hide' : 'sidebar.subagents.show', props.subagents.length)}
                onClick={() => actions.toggleSubagents(member.key)}
                className="mr-0.5 inline-flex h-5 shrink-0 items-center gap-0.5 rounded-sm px-1 text-xs tabular-nums text-subtle hover:bg-surface-hover hover:text-text"
              >
                <ChevronRight className={cn('size-3 transition-transform duration-150', props.subagentsOpen && 'rotate-90')} aria-hidden />
                {props.subagents.length}
              </button>
            )}
            {/* Take room only while they can be used, so the name keeps the row's whole width otherwise. */}
            <span data-testid="row-actions" className={ROW_ACTIONS}>
              {entry && (
                <button
                  type="button"
                  data-testid="close-session"
                  aria-label={t('sessions.closeNamed', { name: title })}
                  title={t('sessions.close')}
                  onClick={() => actions.close(member.key)}
                  className={cn(ROW_ACTION, 'mr-0')}
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              )}
              <OptionsButton label={t('groups.options', { name: title })} menu={menu} />
            </span>
          </div>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content className={MENU_CONTENT}>
            <MenuItems kit={ContextMenu as unknown as MenuKit} build={menu} />
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
      {props.subagentsOpen && props.subagents.length > 0 && (
        <ul className="mt-0.5 ml-6 flex flex-col gap-0.5" aria-label={tn('sidebar.subagents.list', props.subagents.length, { name: title })} data-testid="subagent-rows">
          {props.subagents.map((s) => (
            <SubagentRow key={s.id} subagent={s} onOpen={() => actions.openSubagent(member.key, s.id)} />
          ))}
        </ul>
      )}
    </li>
  )
}, sameRow)

/** A sub-agent under its session's row: its state, kind and task; a click opens its conversation. */
function SubagentRow({ subagent: s, onOpen }: { subagent: SubagentSummary; onOpen: () => void }) {
  const { t } = useI18n()
  const name = s.description ?? s.name ?? s.type ?? s.id
  const running = s.status === undefined || s.status === 'running' || s.status === 'background'
  const tone = s.status === 'failed' ? 'danger' : running ? 'info' : s.status === 'completed' ? 'success' : 'neutral'
  return (
    <li>
      <button
        type="button"
        data-testid="sidebar-subagent"
        onClick={onOpen}
        aria-label={t('subagent.open', { name })}
        title={s.lastStep ? `${name}\n${s.lastStep}` : name}
        className="flex w-full min-w-0 items-center gap-2 rounded-md py-1 pr-1 pl-2 text-left text-sm text-muted hover:bg-surface-hover hover:text-text"
      >
        <Bot className="size-3.5 shrink-0 text-subtle" aria-hidden />
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

/** The row of the session on screen (or the folded group that holds it): a tinted fill with an edge, apart from a hover. */
const SELECTED_ROW = 'bg-accent/20 text-text ring-1 ring-accent/50 ring-inset'

/** The colour of a row's state text when it needs you; working and idle stay quiet. */
const STATUS_TEXT: Record<StatusLevel, string> = { error: 'text-danger', needsAnswer: 'text-warning', readyToReview: 'text-success', working: 'text-info' }

/** A session row's hover actions: out of the layout until the row is hovered or focused, or its menu is open. */
const ROW_ACTIONS = 'hidden shrink-0 items-center group-hover/row:flex group-focus-within/row:flex has-[[data-state=open]]:flex'

const ROW_ACTION =
  'mr-1 inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-subtle opacity-0 transition-opacity hover:bg-surface-hover hover:text-text focus-visible:opacity-100 group-hover/row:opacity-100 group-focus-within/row:opacity-100 data-[state=open]:opacity-100'

function OptionsButton({ label, menu }: { label: string; menu: () => MenuItem[] }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger aria-label={label} className={ROW_ACTION}>
        <Ellipsis className="size-3.5" aria-hidden />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={4} className={MENU_CONTENT}>
          <MenuItems kit={DropdownMenu as unknown as MenuKit} build={menu} />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

function GroupHeader(props: {
  group: SessionGroup
  summary: ReturnType<typeof summarize>
  /** The session on screen is one of its members: the header stands in for its row while folded. */
  selectedInside: boolean
  dropping: boolean
  menu: () => MenuItem[]
  onToggle: () => void
  onMove: (step: -1 | 1) => void
  onDragOver: (e: DragEvent) => void
  onDragLeave: () => void
  onDrop: (e: DragEvent) => void
}) {
  const { t, tn } = useI18n()
  const { group, summary } = props
  const Icon = group.collapsed ? FolderClosed : FolderOpen
  const standsIn = props.selectedInside && group.collapsed
  const onKey = (e: KeyboardEvent) => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
    e.preventDefault()
    props.onMove(e.key === 'ArrowUp' ? -1 : 1)
  }
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div
          draggable
          data-testid="group-row"
          onDragStart={(e) => {
            e.dataTransfer.setData(GROUP_DRAG, group.id)
            e.dataTransfer.effectAllowed = 'move'
          }}
          onDragOver={props.onDragOver}
          onDragLeave={props.onDragLeave}
          onDrop={props.onDrop}
          data-selected-inside={props.selectedInside || undefined}
          className={cn(
            'group/row flex items-center rounded-md transition-colors duration-150',
            standsIn ? SELECTED_ROW : 'text-muted hover:bg-surface-hover hover:text-text',
            props.dropping && 'ring-2 ring-accent/60'
          )}
        >
          <button
            type="button"
            onClick={props.onToggle}
            onKeyDown={onKey}
            aria-expanded={!group.collapsed}
            className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md pr-1 pl-2 text-left"
          >
            <ChevronRight className={cn('size-3.5 shrink-0 text-subtle transition-transform duration-150', !group.collapsed && 'rotate-90')} aria-hidden />
            <Icon className={cn('size-3.5 shrink-0', props.selectedInside ? 'text-accent' : 'text-subtle')} aria-hidden />
            <span className="min-w-0 flex-1 truncate text-base font-medium">{group.name}</span>
            {summary.count > 0 && (
              <Badge
                tone={summary.level && summary.level !== 'working' ? LEVEL_TONE[summary.level] : 'accent'}
                data-testid="group-badge"
                title={tn('groups.badge', summary.count)}
              >
                {summary.count}
                <span className="sr-only"> {tn('groups.badge', summary.count)}</span>
              </Badge>
            )}
            {summary.level && (
              <span data-testid="group-dot" data-level={summary.level} className="inline-flex" title={t(LEVEL_LABEL[summary.level])}>
                <StateDot tone={LEVEL_TONE[summary.level]} pulse={summary.level === 'working'} />
                <span className="sr-only">{t(LEVEL_LABEL[summary.level])}</span>
              </span>
            )}
          </button>
          <OptionsButton label={t('groups.options', { name: group.name })} menu={props.menu} />
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={MENU_CONTENT}>
          <MenuItems kit={ContextMenu as unknown as MenuKit} build={props.menu} />
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}

function GroupDialog({
  dialog,
  closedLost,
  onClose,
  onCreate,
  onRename,
  onDelete
}: {
  dialog: Dialogs
  closedLost: number
  onClose: () => void
  onCreate: (name: string, member?: GroupMember) => void
  onRename: (id: string, name: string) => void
  onDelete: (id: string) => void
}) {
  const { t, tn } = useI18n()
  const [name, setName] = useState('')
  const [seen, setSeen] = useState<Dialogs>(null)
  // Fill the field when a dialog opens (the group's name to rename, empty to create).
  if (dialog !== seen) {
    setSeen(dialog)
    setName(dialog?.kind === 'rename' ? dialog.group.name : '')
  }
  if (!dialog) return null
  const finish = () => {
    const trimmed = name.trim() || t('groups.defaultName')
    if (dialog.kind === 'create') onCreate(trimmed, dialog.member)
    else if (dialog.kind === 'rename') onRename(dialog.group.id, trimmed)
    else onDelete(dialog.group.id)
    onClose()
  }
  if (dialog.kind === 'delete') {
    return (
      <Dialog
        open
        onOpenChange={(o) => !o && onClose()}
        title={t('groups.deleteTitle', { name: dialog.group.name })}
        description={t('groups.deleteBody')}
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button variant="danger" data-testid="confirm-delete-group" onClick={finish}>
              {t('groups.delete')}
            </Button>
          </>
        }
      >
        {closedLost > 0 ? <p className="text-base text-muted">{tn('groups.closedLost', closedLost)}</p> : null}
      </Dialog>
    )
  }
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={dialog.kind === 'create' ? t('groups.newTitle') : t('groups.renameTitle')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" data-testid="save-group" onClick={finish}>
            {dialog.kind === 'create' ? t('groups.create') : t('groups.save')}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          finish()
        }}
      >
        <Field label={t('groups.name')}>
          <Input autoFocus value={name} maxLength={60} placeholder={t('groups.defaultName')} data-testid="group-name" onChange={(e) => setName(e.target.value)} />
        </Field>
      </form>
    </Dialog>
  )
}
