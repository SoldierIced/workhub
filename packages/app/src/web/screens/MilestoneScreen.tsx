import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-react'
import { useState } from 'react'
import { openTicketsAt, type MilestoneOpenTickets } from '@workhub/core'
import { Badge, Spinner } from '../../renderer/components/atoms'
import { Markdown } from '../../renderer/components/molecules/Markdown'
import { useI18n } from '../../renderer/i18n/I18nProvider'
import { explainsBehind, MILESTONE_STATUS_LABEL, MILESTONE_STATUS_TONE, openTicketsHidden, openTicketsSummary, OPEN_FLAG_LABEL, OPEN_FLAG_TONE, PIECE_KIND_LABEL, PIECE_STATE_LABEL, PIECE_STATE_TONE } from '../../renderer/lib/planner'
import { relativeTime } from '../../renderer/lib/pullRequests'
import { navigate, useClientStatus, useConfig, useProfileId } from '../app-context'
import { openLink, shortDateRange, useMilestoneOpenTickets, usePlanner } from '../plan-data'
import { BigButton, Body, Empty, Header, Row, Screen, SectionTitle } from '../ui'
import { ProgressBar } from './PlanScreen'

/** One milestone: its progress against time, how it is counted, its pieces, notes and links; a typed progress can be moved here, and the milestone deleted. */
export function MilestoneScreen({ id }: { id: string }) {
  const { t, tn, formatDate, locale } = useI18n()
  const { config } = useConfig()
  const [profileId] = useProfileId(config)
  const planner = usePlanner(profileId)
  const view = planner.data
  const row = view?.milestones.find((m) => m.milestone.id === id)
  const [progress, setProgress] = useState<number | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [showOpen, setShowOpen] = useState(false)
  const [showQuery, setShowQuery] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!view || !row || !profileId) {
    return (
      <Screen>
        <Header title={t('planner.tab.milestones')} back={{ screen: 'plan', tab: 'milestones' }} />
        <Body>{!view && planner.loading ? <Spinner className="mx-auto mt-16 size-6" /> : <Empty title={t('planner.detail.missing')} hint={t('planner.detail.missingHint')} />}</Body>
      </Screen>
    )
  }
  const m = row.milestone
  const manual = m.source.kind === 'manual' ? m.source.progress : null
  const shown = progress ?? manual ?? row.progress

  const saveProgress = async () => {
    if (progress === null || m.source.kind !== 'manual') return
    setBusy(true)
    setError(null)
    try {
      const r = await window.hub.planner.saveMilestone(profileId, { ...m, source: { kind: 'manual', progress } })
      if (!r.ok) setError(r.error)
      else setProgress(null)
      planner.reload()
    } finally {
      setBusy(false)
    }
  }
  const remove = async () => {
    setBusy(true)
    try {
      const r = await window.hub.planner.deleteMilestone(profileId, m.id)
      if (!r.ok) setError(r.error)
      else navigate({ screen: 'plan', tab: 'milestones' }, true)
    } finally {
      setBusy(false)
    }
  }
  const openTotal = row.counts?.open?.total ?? 0
  const sourceLabel = m.source.kind === 'manual' ? 'planner.milestone.source.manual' : m.source.kind === 'tracker' ? 'planner.milestone.source.tracker' : 'planner.milestone.source.items'
  return (
    <Screen>
      <Header title={t('planner.tab.milestones')} back={{ screen: 'plan', tab: 'milestones' }} />
      <Body>
        <div className="flex flex-col gap-3 px-4 pt-4">
          <div className="flex items-center gap-2">
            <h1 className="min-w-0 flex-1 text-xl font-semibold leading-snug">{m.name}</h1>
            <Badge tone={MILESTONE_STATUS_TONE[row.status]}>{t(MILESTONE_STATUS_LABEL[row.status])}</Badge>
          </div>
          <ProgressBar name={m.name} progress={shown} elapsed={row.elapsed} status={row.status} />
          <div className="flex flex-wrap justify-between gap-x-3 text-xs text-muted">
            <span>{t('planner.milestone.progressOf', { progress: shown, elapsed: row.elapsed })}</span>
            <span className="whitespace-nowrap">{shortDateRange(m.start, m.end, formatDate, t('web.milestone.range'))}</span>
          </div>
          {row.error && <p className="rounded-lg bg-warning-soft px-3 py-2 text-xs text-warning">{t('planner.milestone.countFailed', { message: row.error })}</p>}
        </div>

        {m.source.kind === 'manual' && (
          <>
            <SectionTitle>{t('planner.detail.progress')}</SectionTitle>
            <div className="mx-4 flex items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3">
              <input type="range" min={0} max={100} step={5} value={shown} onChange={(e) => setProgress(Number(e.target.value))} aria-label={t('planner.milestone.progress')} className="h-11 min-w-0 flex-1 accent-[var(--color-accent)]" />
              <span className="w-12 text-right font-mono text-sm">{shown}%</span>
              <button type="button" disabled={progress === null || busy} onClick={() => void saveProgress()} className="min-h-11 min-w-11 rounded-lg bg-accent px-3 text-sm font-medium text-accent-fg disabled:opacity-45">
                {t('planner.detail.save')}
              </button>
            </div>
          </>
        )}

        <SectionTitle>{t('planner.detail.source')}</SectionTitle>
        <div className="mx-4 rounded-xl border border-border bg-surface">
          <Row>
            <div className="text-sm">{t(sourceLabel)}</div>
            {row.counts && <div className="mt-0.5 text-xs text-muted">{t('planner.detail.countsValue', { done: row.counts.done, total: row.counts.total, inProgress: row.counts.inProgress, todo: row.counts.todo })}</div>}
            {row.counts && (
              <div className="mt-0.5 text-xs text-subtle" data-testid="milestone-counted">
                {t('planner.milestone.counted', { time: relativeTime(row.counts.at, Date.now(), locale) })}
              </div>
            )}
            {explainsBehind(row.status) && openTotal > 0 && <p className="mt-1 text-sm text-text">{openTicketsSummary(row.counts?.open, tn)}</p>}
          </Row>
          {openTotal > 0 && (
            <div className="border-t border-border">
              <button type="button" aria-expanded={showOpen} aria-controls="milestone-open-tickets" onClick={() => setShowOpen((v) => !v)} className="flex min-h-11 w-full items-center gap-2 px-4 py-2 text-left text-sm font-medium text-accent active:bg-surface-hover">
                {showOpen ? <ChevronDown className="size-4 shrink-0" aria-hidden /> : <ChevronRight className="size-4 shrink-0" aria-hidden />}
                <span className="min-w-0 flex-1">{tn('planner.open.control', openTotal)}</span>
              </button>
              <div id="milestone-open-tickets" hidden={!showOpen}>
                {showOpen && <OpenTickets profileId={profileId} milestoneId={m.id} view={view} />}
              </div>
            </div>
          )}
          {m.source.kind === 'tracker' && (
            <div className="border-t border-border">
              <button type="button" aria-expanded={showQuery} aria-controls="milestone-query" onClick={() => setShowQuery((v) => !v)} className="flex min-h-11 w-full items-center gap-2 px-4 py-2 text-left text-sm text-muted active:bg-surface-hover">
                {showQuery ? <ChevronDown className="size-4 shrink-0" aria-hidden /> : <ChevronRight className="size-4 shrink-0" aria-hidden />}
                <span className="min-w-0 flex-1">{t(showQuery ? 'web.milestone.hideQuery' : 'web.milestone.showQuery')}</span>
              </button>
              <div id="milestone-query" hidden={!showQuery}>
                {showQuery && <div className="break-all px-4 pb-3 font-mono text-xs text-muted">{m.source.query}</div>}
              </div>
            </div>
          )}
        </div>

        {row.pieces && row.pieces.length > 0 && (
          <>
            <SectionTitle>{t('planner.pieces.title')}</SectionTitle>
            <ul className="mx-4 divide-y divide-border rounded-xl border border-border bg-surface">
              {row.pieces.map((p, i) => (
                <li key={i}>
                  <Row onClick={p.url ? () => openLink(p.url!) : p.piece.kind === 'task' ? () => navigate({ screen: 'planItem', id: (p.piece as { itemId: string }).itemId }) : undefined} right={p.url ? <ExternalLink className="size-4 text-subtle" aria-hidden /> : undefined}>
                    <div className="flex items-center gap-2">
                      <Badge tone={PIECE_STATE_TONE[p.state]}>{t(PIECE_STATE_LABEL[p.state])}</Badge>
                      <span className="truncate text-sm">{p.title}</span>
                    </div>
                    <div className="mt-0.5 text-xs text-muted">
                      {t(PIECE_KIND_LABEL[p.piece.kind])} · {t('planner.pieces.shareOf', { share: p.share })}
                    </div>
                  </Row>
                </li>
              ))}
            </ul>
          </>
        )}

        {m.notes && (
          <>
            <SectionTitle>{t('planner.detail.notes')}</SectionTitle>
            <div className="px-4">
              <Markdown text={m.notes} className="text-md" />
            </div>
          </>
        )}

        {(m.link || (m.links?.length ?? 0) > 0) && (
          <>
            <SectionTitle>{t('planner.links.title')}</SectionTitle>
            <div className="mx-4 rounded-xl border border-border bg-surface">
              {[...(m.link ? [{ label: m.link, url: m.link }] : []), ...(m.links ?? [])].map((l) => (
                <Row key={l.url} className="border-t border-border first:border-t-0" onClick={() => openLink(l.url)} right={<ExternalLink className="size-4 text-subtle" aria-hidden />}>
                  <div className="truncate text-sm text-accent">{l.label || l.url}</div>
                </Row>
              ))}
            </div>
          </>
        )}

        {(m.updatedAt || m.createdAt) && <p className="px-4 pt-4 text-xs text-subtle">{t('planner.detail.updated', { time: formatDate(m.updatedAt ?? m.createdAt!, { dateStyle: 'medium', timeStyle: 'short' }) })}</p>}
        {error && <p className="px-4 pt-3 text-sm text-danger">{error}</p>}
        <div className="px-4 pt-6 pb-6">
          {deleting ? (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-sm">
              <span className="min-w-0 basis-full">{t('planner.milestone.confirmDelete', { name: m.name })}</span>
              <button type="button" onClick={() => setDeleting(false)} className="min-h-11 min-w-11 flex-1 rounded-md border border-border-strong px-3 text-sm">
                {t('web.cancel')}
              </button>
              <button type="button" onClick={() => (setDeleting(false), void remove())} className="min-h-11 min-w-11 flex-1 rounded-md bg-danger px-3 text-sm font-semibold text-white">
                {t('planner.milestone.remove', { name: m.name })}
              </button>
            </div>
          ) : (
            <BigButton variant="danger" disabled={busy} onClick={() => setDeleting(true)}>
              {t('planner.milestone.remove', { name: m.name })}
            </BigButton>
          )}
        </div>
      </Body>
    </Screen>
  )
}

/** The list of open tickets, asked from the computer when it is opened: while it loads, when the computer cannot be reached, when it comes back empty, and the tickets. */
function OpenTickets({ profileId, milestoneId, view }: { profileId: string; milestoneId: string; view: unknown }) {
  const { t } = useI18n()
  const status = useClientStatus()
  const { ask, reload } = useMilestoneOpenTickets(profileId, milestoneId, view)
  const online = status.state === 'online'
  if (!online) return <OpenTicketsNote text={t('web.milestone.unreachable')} action={{ label: t('web.retry'), run: reload }} />
  if (ask.state === 'failed') return <OpenTicketsNote text={t('web.milestone.unreachable')} action={{ label: t('web.retry'), run: reload }} />
  if (ask.state === 'loading') return <OpenTicketsNote text={t('web.milestone.loading')} spinner />
  // `null` is "not known": never counted, counted before open tickets existed, or the query changed. It is not "none open".
  if (ask.open === null) return <OpenTicketsNote text={t('web.milestone.unknown')} />
  if (ask.open.tickets.length === 0) return <OpenTicketsNote text={t('web.milestone.empty')} />
  return <OpenTicketsList open={ask.open} />
}

function OpenTicketsNote({ text, spinner, action }: { text: string; spinner?: boolean; action?: { label: string; run: () => void } }) {
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 pb-3 text-sm text-muted" data-testid="milestone-open-note">
      {spinner && <Spinner className="size-4" />}
      <span className="min-w-0 flex-1 basis-40">{text}</span>
      {action && (
        <button type="button" onClick={action.run} className="min-h-11 min-w-11 rounded-md px-3 text-sm font-medium text-accent">
          {action.label}
        </button>
      )}
    </div>
  )
}

/** Each open ticket on one 390 px row: key and title (the title wraps), a badge per flag, who has it, when it was last updated. A row with an address opens it in the phone's browser. */
export function OpenTicketsList({ open: counted, now = Date.now() }: { open: MilestoneOpenTickets; now?: number }) {
  const { t, tn, locale } = useI18n()
  // "No movement" is worked out now, from the same clock as "updated ... ago", not as of the count.
  const open = openTicketsAt(counted, now)
  const hidden = openTicketsHidden(open)
  return (
    <div data-testid="milestone-open-list">
      <ul className="divide-y divide-border border-t border-border">
        {open.tickets.map((k) => {
          const body = (
            <>
              <div className="min-w-0 break-words text-sm">
                <span className="font-mono font-medium">{k.key}</span>
                {k.title && k.title !== k.key && <span className="text-text"> {k.title}</span>}
              </div>
              {k.flags.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {k.flags.map((f) => (
                    <Badge key={f} tone={OPEN_FLAG_TONE[f]} className="h-auto whitespace-normal py-0.5">
                      {t(OPEN_FLAG_LABEL[f])}
                    </Badge>
                  ))}
                </div>
              )}
              {(typeof k.assignee === 'string' || k.updatedAt !== undefined) && (
                <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-muted">
                  {typeof k.assignee === 'string' && <span className="min-w-0 break-words">{k.assignee}</span>}
                  {k.updatedAt !== undefined && <span>{t('planner.open.updated', { time: relativeTime(k.updatedAt, now, locale) })}</span>}
                </div>
              )}
            </>
          )
          // What a screen reader says: the whole row, not only that it opens the ticket.
          const spoken = [
            k.title && k.title !== k.key ? `${k.key} ${k.title}` : k.key,
            ...k.flags.map((f) => t(OPEN_FLAG_LABEL[f])),
            ...(typeof k.assignee === 'string' ? [k.assignee] : []),
            ...(k.updatedAt !== undefined ? [t('planner.open.updated', { time: relativeTime(k.updatedAt, now, locale) })] : [])
          ].join(', ')
          return (
            <li key={k.key} data-testid="milestone-open-ticket">
              {k.url ? (
                <button type="button" aria-label={t('web.milestone.openRow', { row: spoken })} onClick={() => openLink(k.url!)} className="flex min-h-11 w-full items-center gap-3 px-4 py-2.5 text-left active:bg-surface-hover">
                  <div className="min-w-0 flex-1">{body}</div>
                  <ExternalLink className="size-4 shrink-0 text-subtle" aria-hidden />
                </button>
              ) : (
                <div className="min-h-11 px-4 py-2.5">{body}</div>
              )}
            </li>
          )
        })}
      </ul>
      {hidden > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 border-t border-border px-4 py-1 text-xs text-muted">
          <span className="min-w-0 py-2">{tn('planner.open.more', hidden)}</span>
          {open.url && (
            <button type="button" onClick={() => openLink(open.url!)} className="min-h-11 min-w-11 text-sm font-medium text-accent">
              {t('planner.open.seeAll')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
