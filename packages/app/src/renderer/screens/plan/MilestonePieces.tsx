import { Link2, ListTodo, Plus, Ticket, Trash2 } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { parseTicketKey, pieceId, pieceShares, PIECE_LIMITS, PIECE_WEIGHT, type Connection, type InboxItem, type MilestonePiece, type PieceKind, type PieceView } from '@workhub/core'
import { Badge, Button, Input, Select } from '../../components/atoms'
import { useI18n } from '../../i18n/I18nProvider'
import type { MessageKey } from '../../i18n/translate'
import { cn } from '../../lib/cn'
import { errorText } from '../../lib/errorText'
import { INBOX_STATUS_LABEL, PIECE_KIND_LABEL, PIECE_STATE_LABEL, PIECE_STATE_TONE, pieceTaskChoices } from '../../lib/planner'
import { relativeTime } from '../../lib/pullRequests'

const KIND_ICON: Record<PieceKind, (cls: string) => ReactNode> = {
  ticket: (cls) => <Ticket className={cls} aria-hidden />,
  task: (cls) => <ListTodo className={cls} aria-hidden />,
  link: (cls) => <Link2 className={cls} aria-hidden />
}

const WEIGHTS = Array.from({ length: PIECE_WEIGHT.max - PIECE_WEIGHT.min + 1 }, (_v, i) => String(PIECE_WEIGHT.min + i))

/** What a ticket piece's title is while the editor reads it. */
type Lookup = { state: 'reading' } | { state: 'found'; title: string } | { state: 'missing' } | { state: 'failed'; message: string }

/** The name of a piece in the editor: a ticket's key (and title once read), a task's title, a link's label. */
function pieceName(p: MilestonePiece, inbox: readonly InboxItem[], titles: Record<string, Lookup>): string {
  if (p.kind === 'ticket') {
    const l = titles[pieceId(p)]
    return l?.state === 'found' && l.title ? `${p.key} · ${l.title}` : p.key
  }
  if (p.kind === 'task') return inbox.find((i) => i.id === p.itemId)?.title ?? p.itemId
  return p.label
}

/**
 * The pieces of a milestone as its form edits them: add a ticket by key (its title is read from
 * the tracker), one of the profile's open tasks, or a link; set each one's weight from 1 to 10 and
 * see its share; remove one at once (the form is saved, or cancelled, as a whole).
 */
export function PiecesEditor({ profileId, pieces, onChange, inbox, trackers }: { profileId: string; pieces: MilestonePiece[]; onChange: (pieces: MilestonePiece[]) => void; inbox: readonly InboxItem[]; trackers: Connection[] }) {
  const { t } = useI18n()
  const [key, setKey] = useState('')
  const [connectionId, setConnectionId] = useState('')
  const [taskText, setTaskText] = useState('')
  const [linkUrl, setLinkUrl] = useState('')
  const [linkLabel, setLinkLabel] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [titles, setTitles] = useState<Record<string, Lookup>>({})
  const shares = pieceShares(pieces)
  const full = pieces.length >= PIECE_LIMITS.items
  const choices = pieceTaskChoices(inbox, pieces, taskText).slice(0, 8)

  const add = (piece: MilestonePiece): boolean => {
    if (full) {
      setProblem(t('planner.pieces.tooMany', { max: PIECE_LIMITS.items }))
      return false
    }
    if (pieces.some((p) => pieceId(p) === pieceId(piece))) {
      setProblem(t('planner.pieces.duplicate'))
      return false
    }
    setProblem(null)
    onChange([...pieces, piece])
    return true
  }
  const addTicket = async () => {
    const k = parseTicketKey(key)
    if (!k) return setProblem(t('planner.pieces.badKey'))
    const piece: MilestonePiece = { kind: 'ticket', key: k, ...(connectionId ? { connectionId } : {}), weight: PIECE_WEIGHT.default }
    if (!add(piece)) return
    setKey('')
    const id = pieceId(piece)
    setTitles((m) => ({ ...m, [id]: { state: 'reading' } }))
    try {
      const r = await window.hub.planner.lookupTicket(profileId, k, connectionId || undefined)
      const next: Lookup = !r.ok ? { state: 'failed', message: r.error } : r.ticket ? { state: 'found', title: r.ticket.title } : { state: 'missing' }
      setTitles((m) => ({ ...m, [id]: next }))
    } catch (e) {
      setTitles((m) => ({ ...m, [id]: { state: 'failed', message: errorText(e) } }))
    }
  }
  const addLink = () => {
    const url = linkUrl.trim()
    if (!/^https?:\/\/\S+$/i.test(url) || url.length > PIECE_LIMITS.url) return setProblem(t('planner.pieces.badLink'))
    if (add({ kind: 'link', url, label: linkLabel.replace(/\s+/g, ' ').trim().slice(0, PIECE_LIMITS.label) || url, done: false, weight: PIECE_WEIGHT.default })) {
      setLinkUrl('')
      setLinkLabel('')
    }
  }
  const set = (index: number, patch: Partial<MilestonePiece>) => onChange(pieces.map((p, i) => (i === index ? ({ ...p, ...patch } as MilestonePiece) : p)))

  return (
    <div className="flex flex-col gap-3" role="group" aria-label={t('planner.pieces.title')} data-testid="pieces-editor">
      <p className="text-xs text-muted">{t('planner.pieces.hint')}</p>
      {pieces.length === 0 ? (
        <p className="text-sm text-muted">{t('planner.pieces.empty')}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
          {pieces.map((p, i) => {
            const name = pieceName(p, inbox, titles)
            const lookup = p.kind === 'ticket' ? titles[pieceId(p)] : undefined
            return (
              <li key={pieceId(p)} className="flex flex-col gap-1 px-2.5 py-1.5">
                <div className="flex items-center gap-2">
                  <span className="text-muted" title={t(PIECE_KIND_LABEL[p.kind])}>
                    {KIND_ICON[p.kind]('size-3.5 shrink-0')}
                  </span>
                  {p.kind === 'link' && <input type="checkbox" className="size-4 accent-[var(--color-accent)]" checked={p.done} onChange={(e) => set(i, { done: e.target.checked })} aria-label={t('planner.pieces.linkDone', { name })} />}
                  <span className={cn('min-w-0 flex-1 truncate text-sm', p.kind === 'ticket' && 'font-mono')} title={name}>
                    {name}
                  </span>
                  <div className="w-16 shrink-0">
                    <Select value={String(p.weight)} onChange={(v) => set(i, { weight: Number(v) })} options={WEIGHTS.map((w) => ({ value: w, label: w }))} aria-label={t('planner.pieces.weightOf', { name })} />
                  </div>
                  <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted" title={t('planner.pieces.shareOf', { share: shares[i] ?? 0 })}>
                    {t('planner.pieces.share', { share: shares[i] ?? 0 })}
                  </span>
                  <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" aria-hidden />} aria-label={t('planner.pieces.remove', { name })} title={t('planner.pieces.remove', { name })} onClick={() => onChange(pieces.filter((_p, j) => j !== i))} />
                </div>
                {lookup && lookup.state !== 'found' && (
                  <p role="status" className={cn('pl-6 text-xs', lookup.state === 'reading' ? 'text-muted' : 'text-warning')}>
                    {lookup.state === 'reading' ? t('planner.pieces.reading', { key: name }) : lookup.state === 'missing' ? t('planner.pieces.notFound', { key: name }) : t('planner.pieces.lookupFailed', { key: name, message: lookup.message })}
                  </p>
                )}
              </li>
            )
          })}
        </ul>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted">{t('planner.pieces.addTicket')}</span>
          <Input
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void addTicket()
              }
            }}
            placeholder="ABC-12"
            aria-label={t('planner.pieces.ticketKey')}
            spellCheck={false}
            className="font-mono"
          />
          {trackers.length > 1 && <Select value={connectionId} onChange={setConnectionId} aria-label={t('planner.milestone.connection')} options={[{ value: '', label: t('planner.milestone.connectionDefault') }, ...trackers.map((c) => ({ value: c.id, label: c.name || c.id }))]} />}
          <div>
            <Button size="sm" variant="secondary" icon={<Plus className="size-3.5" aria-hidden />} disabled={full || !key.trim()} onClick={() => void addTicket()}>
              {t('planner.pieces.addTicket')}
            </Button>
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted">{t('planner.pieces.addTask')}</span>
          <Input value={taskText} onChange={(e) => setTaskText(e.target.value)} placeholder={t('planner.pieces.taskSearch')} aria-label={t('planner.pieces.taskSearch')} />
          {choices.length === 0 ? (
            <p className="text-xs text-muted">{t('planner.pieces.noTasks')}</p>
          ) : (
            <ul className="flex max-h-40 flex-col overflow-y-auto rounded-md border border-border" aria-label={t('planner.pieces.addTask')}>
              {choices.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    disabled={full}
                    className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-sm hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none disabled:opacity-50"
                    onClick={() => {
                      if (add({ kind: 'task', itemId: item.id, weight: PIECE_WEIGHT.default })) setTaskText('')
                    }}
                  >
                    <Plus className="size-3 shrink-0 text-muted" aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{item.title}</span>
                    <span className="shrink-0 text-xs text-subtle">{t(INBOX_STATUS_LABEL[item.status])}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted">{t('planner.pieces.addLink')}</span>
          <Input value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} placeholder="https://" aria-label={t('planner.pieces.linkUrl')} spellCheck={false} maxLength={PIECE_LIMITS.url} />
          <Input value={linkLabel} onChange={(e) => setLinkLabel(e.target.value)} placeholder={t('planner.pieces.linkLabel')} aria-label={t('planner.pieces.linkLabel')} maxLength={PIECE_LIMITS.label} />
          <div>
            <Button size="sm" variant="secondary" icon={<Plus className="size-3.5" aria-hidden />} disabled={full || !linkUrl.trim()} onClick={addLink}>
              {t('planner.pieces.addLink')}
            </Button>
          </div>
        </div>
      </div>
      {problem && (
        <p role="alert" className="text-sm text-danger">
          {problem}
        </p>
      )}
    </div>
  )
}

/** Why a piece's state is not known, or how old it is. */
function pieceNote(v: PieceView, t: ReturnType<typeof useI18n>['t'], locale: string): string | null {
  if (v.missing) return t('planner.pieces.missingTask')
  if (v.error === 'missing') return t('planner.pieces.missingTicket')
  if (v.error === 'unsupported') return t('planner.pieces.unsupported')
  if (v.error) return t('planner.pieces.readFailed', { message: v.error })
  if (v.piece.kind === 'ticket' && v.checkedAt === undefined) return t('planner.pieces.notRead')
  if (v.checkedAt !== undefined) return t('planner.pieces.checked', { time: relativeTime(v.checkedAt, Date.now(), locale) })
  return null
}

/** A piece's state as a badge: a task shows its inbox status, the others their state. */
function StateBadge({ v }: { v: PieceView }) {
  const { t } = useI18n()
  const label: MessageKey = v.piece.kind === 'task' && v.status && v.status in INBOX_STATUS_LABEL ? INBOX_STATUS_LABEL[v.status as InboxItem['status']] : PIECE_STATE_LABEL[v.state]
  return (
    <Badge tone={PIECE_STATE_TONE[v.state]} title={v.piece.kind === 'ticket' && v.status ? v.status : undefined}>
      {t(label)}
    </Badge>
  )
}

/**
 * A milestone's pieces with their live state, weight and share. `compact` (the Milestones tab) is
 * one line each, at most `limit` of them; otherwise (the milestone's window) each piece opens
 * (a ticket's or link's address, a task's window) and a link's done box can be ticked.
 */
export function PiecesList({ pieces, profileId, compact = false, limit, onOpenTask, onToggleLink }: { pieces: PieceView[]; profileId: string; compact?: boolean; limit?: number; onOpenTask?: (itemId: string) => void; onToggleLink?: (index: number, done: boolean) => void }) {
  const { t, tn, locale } = useI18n()
  if (pieces.length === 0) return <p className="text-sm text-muted">{t('planner.pieces.empty')}</p>
  const shown = limit !== undefined ? pieces.slice(0, limit) : pieces
  const done = pieces.filter((v) => v.state === 'done').length
  return (
    <div className="flex flex-col gap-1" data-testid="milestone-pieces">
      <p className="text-xs text-muted">{t('planner.pieces.summary', { done, count: pieces.length })}</p>
      <ul className={cn('flex flex-col', !compact && 'divide-y divide-border rounded-md border border-border')}>
        {shown.map((v, i) => {
          const p = v.piece
          const label = p.kind === 'ticket' ? (v.title && v.title !== p.key ? `${p.key} · ${v.title}` : p.key) : v.title
          const note = compact ? null : pieceNote(v, t, locale)
          const open = p.kind === 'task' ? (onOpenTask ? () => onOpenTask(p.itemId) : undefined) : v.url ? () => window.hub.openExternal(v.url!, profileId) : undefined
          return (
            <li key={pieceId(p)} className={cn('flex flex-col', compact ? 'py-0.5' : 'gap-0.5 px-2.5 py-1.5')} data-testid="milestone-piece">
              <div className="flex items-center gap-2">
                <span className="text-muted" title={t(PIECE_KIND_LABEL[p.kind])}>
                  {KIND_ICON[p.kind]('size-3.5 shrink-0')}
                </span>
                {p.kind === 'link' && onToggleLink && !compact && <input type="checkbox" className="size-4 accent-[var(--color-accent)]" checked={p.done} onChange={(e) => onToggleLink(i, e.target.checked)} aria-label={t('planner.pieces.linkDone', { name: v.title })} />}
                {open && !compact ? (
                  <button type="button" className={cn('min-w-0 flex-1 truncate rounded-sm text-left text-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40', p.kind === 'ticket' && 'font-mono')} title={label} onClick={open}>
                    {label}
                  </button>
                ) : (
                  <span className={cn('min-w-0 flex-1 truncate', compact ? 'text-xs' : 'text-sm', p.kind === 'ticket' && 'font-mono')} title={label}>
                    {label}
                  </span>
                )}
                <StateBadge v={v} />
                <span className="shrink-0 text-xs tabular-nums text-subtle" title={`${t('planner.pieces.weight')} ${p.weight} · ${t('planner.pieces.shareOf', { share: v.share })}`}>
                  {compact ? t('planner.pieces.share', { share: v.share }) : `${t('planner.pieces.weight')} ${p.weight} · ${t('planner.pieces.share', { share: v.share })}`}
                </span>
              </div>
              {note && <p className={cn('pl-6 text-xs', v.error || v.missing ? 'text-warning' : 'text-subtle')}>{note}</p>}
            </li>
          )
        })}
      </ul>
      {shown.length < pieces.length && <p className="text-xs text-subtle">{tn('planner.pieces.more', pieces.length - shown.length)}</p>}
    </div>
  )
}
