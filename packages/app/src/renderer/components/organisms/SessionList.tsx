import { ChevronRight, Ellipsis, FolderClosed, FolderOpen, FolderPlus, RotateCcw, X } from 'lucide-react'
import { ContextMenu, DropdownMenu } from 'radix-ui'
import { useMemo, useState, type DragEvent, type ElementType, type KeyboardEvent, type ReactNode } from 'react'
import {
  createGroup,
  deleteGroup,
  groupOf,
  moveBy,
  moveGroupBy,
  moveGroupOnto,
  moveOnto,
  moveToGroup,
  reconcileTop,
  removeMember,
  renameGroup,
  setGroupCollapsed,
  sidebarRows,
  statusLevel,
  ungroup,
  type GroupMember,
  type SessionGroup,
  type SessionGroups,
  type TopSlot
} from '@workhub/core'
import { useI18n } from '../../i18n/I18nProvider'
import { LEVEL_LABEL, LEVEL_TONE } from '../../lib/attention'
import { cn } from '../../lib/cn'
import { folderName } from '../../lib/home'
import { listSessions, memberOf, newGroupId, summarize, updateGroups, type ListedSession } from '../../lib/sessionGroups'
import { awaitingAnswer, pushItem } from '../../store'
import { Badge } from '../atoms/Badge'
import { Button } from '../atoms/Button'
import { Input } from '../atoms/Input'
import { STATE_TONE, StateDot } from '../atoms/StateDot'
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
  /** The Slack badge of a row that owns followed threads opens the Slack screen. */
  onOpenSlack?: () => void
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
export function SessionList({ sessions, groups, selectedId, active, onSelect, onReopen, onOpenSlack }: SessionListProps) {
  const { t, tn } = useI18n()
  const listed = useMemo(() => listSessions(sessions), [sessions])
  const liveKeys = useMemo(() => listed.map((s) => s.key), [listed])
  const rows = useMemo(() => sidebarRows(groups, listed), [groups, listed])
  const state = useMemo(() => reconcileTop(groups, liveKeys), [groups, liveKeys])
  const [dialog, setDialog] = useState<Dialogs>(null)
  const [over, setOver] = useState<string | null>(null)
  const [closing, setClosing] = useState<SessionData | null>(null)

  const act = (change: (s: SessionGroups) => SessionGroups) => void updateGroups(change, liveKeys)
  const live = useMemo(() => new Set(liveKeys), [liveKeys])

  const closeNow = (data: SessionData) =>
    void window.hub.sessions.close(data.view.id).catch((e: unknown) => pushItem(data.view.id, 'error', t('sessions.closeFailed', { message: errorText(e) })))
  /** Stops the session and drops it from the open sessions; a working one asks first. */
  const requestClose = (data: SessionData) => (isWorking(data) ? setClosing(data) : closeNow(data))

  const sessionMenu = (member: GroupMember): MenuItem[] => {
    const inGroup = groupOf(state, member.key)
    const isLive = live.has(member.key)
    const entry = listed.find((l) => l.key === member.key)
    const items: MenuItem[] = []
    if (!entry || entry.data.view.state === 'stopped') items.push({ label: t('groups.reopen'), onSelect: () => onReopen(member) }, { separator: true })
    if (entry) items.push({ label: t('sessions.close'), onSelect: () => requestClose(entry.data) }, { separator: true })
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

  const sessionItem = (member: GroupMember, entry: ListedSession | undefined, nested: boolean) => (
    <SessionItem
      key={member.key}
      onOpenSlack={onOpenSlack}
      member={member}
      entry={entry}
      nested={nested}
      selected={active && entry !== undefined && selectedId === entry.data.view.id}
      dropping={over === `s:${member.key}`}
      menu={sessionMenu(member)}
      onClose={entry ? () => requestClose(entry.data) : undefined}
      onOpen={() => (entry ? onSelect(entry.data.view.id) : onReopen(member))}
      onMove={(step) => act((s) => moveBy(s, member.key, step))}
      onDragOver={(e) => accept(e, `s:${member.key}`, [SESSION_DRAG, GROUP_DRAG])}
      onDragLeave={() => setOver(null)}
      onDrop={(e) => onDropOnSession(e, member.key)}
    />
  )

  return (
    <div data-testid="session-list">
      <ul className="mt-0.5 flex flex-col gap-0.5" aria-label={t('sidebar.sessionList')}>
        {rows.map((row) => {
          if (row.type === 'session') return sessionItem(memberOf(row.session), row.session, false)
          const { group } = row
          const open = row.members.map((m) => m.session?.data).filter((d): d is SessionData => d !== undefined)
          const summary = summarize(open)
          return (
            <li key={group.id} data-testid="group" data-group={group.name}>
              <GroupHeader
                group={group}
                summary={summary}
                dropping={over === `g:${group.id}`}
                menu={groupMenu(group)}
                onToggle={() => act((s) => setGroupCollapsed(s, group.id, !group.collapsed))}
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

function SessionItem(props: {
  member: GroupMember
  entry: ListedSession | undefined
  nested: boolean
  selected: boolean
  dropping: boolean
  menu: MenuItem[]
  /** Closes the open session; undefined for a closed group member. */
  onClose?: () => void
  onOpen: () => void
  onMove: (step: -1 | 1) => void
  onDragOver: (e: DragEvent) => void
  onDragLeave: () => void
  onDrop: (e: DragEvent) => void
  onOpenSlack?: () => void
}) {
  const { t } = useI18n()
  const { member, entry } = props
  // Threads this session owns (member.key is its stable identity), with a dot for unread replies.
  const slack = useSessionSlack(member.key)
  const data = entry?.data
  const level = data ? statusLevel({ state: data.view.state, unseen: data.unseen, awaitingAnswer: awaitingAnswer(data) }) : null
  const tone = data ? (level ? LEVEL_TONE[level] : STATE_TONE[data.view.state]) : 'neutral'
  const closed = !data
  // A session that was stopped is as good as closed: dimmed, and the row reopens it.
  const stopped = data?.view.state === 'stopped'
  const status = data ? (data.unseen && level ? t(LEVEL_LABEL[level]) : t(`state.${data.view.state}`)) : t('groups.closed')
  const title = data ? data.view.agentName : member.title
  const cwd = data ? data.view.cwd : member.cwd
  const onKey = (e: KeyboardEvent) => {
    // Delete or Backspace closes the focused session, as the close button does.
    if (props.onClose && !e.altKey && !e.metaKey && !e.ctrlKey && (e.key === 'Delete' || e.key === 'Backspace')) {
      e.preventDefault()
      props.onClose()
      return
    }
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
    e.preventDefault()
    props.onMove(e.key === 'ArrowUp' ? -1 : 1)
  }
  return (
    <li>
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>
          <div
            draggable
            data-testid={closed ? 'closed-member' : 'session-row'}
            data-key={member.key}
            data-unseen={data?.unseen}
            onDragStart={(e) => {
              e.dataTransfer.setData(SESSION_DRAG, JSON.stringify(member))
              e.dataTransfer.effectAllowed = 'move'
            }}
            onDragOver={props.onDragOver}
            onDragLeave={props.onDragLeave}
            onDrop={props.onDrop}
            className={cn(
              'group/row flex items-center rounded-md transition-colors duration-150',
              props.selected ? 'bg-accent-soft text-text' : 'text-muted hover:bg-surface-hover hover:text-text',
              props.dropping && 'ring-2 ring-accent/60',
              (closed || stopped) && 'opacity-60'
            )}
          >
            <button
              type="button"
              onClick={props.onOpen}
              onKeyDown={onKey}
              aria-current={props.selected ? 'true' : undefined}
              title={closed ? t('groups.reopen') : cwd}
              className={cn('flex min-w-0 flex-1 items-center gap-2.5 rounded-md py-1.5 pr-1 text-left', props.nested ? 'pl-2' : 'pl-3.5')}
            >
              {closed ? <RotateCcw className="size-3 shrink-0 text-subtle" aria-hidden /> : <StateDot tone={tone} pulse={level === 'working' || data?.view.state === 'busy' || data?.view.state === 'starting'} />}
              <span className="min-w-0 flex-1">
                <span className={cn('block truncate text-base', data?.unseen && 'font-semibold text-text')}>{title}</span>
                <span className="block truncate text-xs text-subtle">
                  {folderName(cwd)} · {data?.view.accountName ? `${data.view.accountName} · ` : ''}
                  {status}
                </span>
              </span>
              {data?.unseen && (
                <span data-testid="unseen-mark" role="img" aria-label={t('attention.unseen')} className="size-2 shrink-0 rounded-full bg-accent" />
              )}
            </button>
            {props.onOpenSlack && <SlackBadge summary={slack.summary} onOpen={props.onOpenSlack} />}
            {props.onClose && (
              <button
                type="button"
                data-testid="close-session"
                aria-label={t('sessions.closeNamed', { name: title })}
                title={t('sessions.close')}
                onClick={props.onClose}
                className={cn(ROW_ACTION, 'mr-0')}
              >
                <X className="size-3.5" aria-hidden />
              </button>
            )}
            <OptionsButton label={t('groups.options', { name: title })} menu={props.menu} />
          </div>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content className={MENU_CONTENT}>{renderMenu(ContextMenu as unknown as MenuKit, props.menu)}</ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
    </li>
  )
}

/** A row's hover actions: shown on hover or keyboard focus. */
const ROW_ACTION =
  'mr-1 inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-subtle opacity-0 transition-opacity hover:bg-surface-hover hover:text-text focus-visible:opacity-100 group-hover/row:opacity-100 group-focus-within/row:opacity-100 data-[state=open]:opacity-100'

function OptionsButton({ label, menu }: { label: string; menu: MenuItem[] }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger aria-label={label} className={ROW_ACTION}>
        <Ellipsis className="size-3.5" aria-hidden />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={4} className={MENU_CONTENT}>
          {renderMenu(DropdownMenu as unknown as MenuKit, menu)}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

function GroupHeader(props: {
  group: SessionGroup
  summary: ReturnType<typeof summarize>
  dropping: boolean
  menu: MenuItem[]
  onToggle: () => void
  onMove: (step: -1 | 1) => void
  onDragOver: (e: DragEvent) => void
  onDragLeave: () => void
  onDrop: (e: DragEvent) => void
}) {
  const { t, tn } = useI18n()
  const { group, summary } = props
  const Icon = group.collapsed ? FolderClosed : FolderOpen
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
          className={cn(
            'group/row flex items-center rounded-md text-muted transition-colors duration-150 hover:bg-surface-hover hover:text-text',
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
            <Icon className="size-3.5 shrink-0 text-subtle" aria-hidden />
            <span className="min-w-0 flex-1 truncate text-base font-medium">{group.name}</span>
            {summary.count > 0 && (
              <Badge tone="accent" data-testid="group-badge" title={tn('groups.badge', summary.count)}>
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
        <ContextMenu.Content className={MENU_CONTENT}>{renderMenu(ContextMenu as unknown as MenuKit, props.menu)}</ContextMenu.Content>
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
