import { ExternalLink } from 'lucide-react'
import { useState } from 'react'
import { Badge, Spinner } from '../../renderer/components/atoms'
import { Markdown } from '../../renderer/components/molecules/Markdown'
import { useI18n } from '../../renderer/i18n/I18nProvider'
import { MILESTONE_STATUS_LABEL, MILESTONE_STATUS_TONE, PIECE_KIND_LABEL, PIECE_STATE_LABEL, PIECE_STATE_TONE } from '../../renderer/lib/planner'
import { navigate, useConfig, useProfileId } from '../app-context'
import { openLink, usePlanner } from '../plan-data'
import { BigButton, Body, Empty, Header, InlineConfirm, Row, Screen, SectionTitle } from '../ui'
import { ProgressBar } from './PlanScreen'

/** One milestone: its progress against time, how it is counted, its pieces, notes and links; a typed progress can be moved here, and the milestone deleted. */
export function MilestoneScreen({ id }: { id: string }) {
  const { t, formatDate } = useI18n()
  const { config } = useConfig()
  const [profileId] = useProfileId(config)
  const planner = usePlanner(profileId)
  const view = planner.data
  const row = view?.milestones.find((m) => m.milestone.id === id)
  const [progress, setProgress] = useState<number | null>(null)
  const [deleting, setDeleting] = useState(false)
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
          <div className="flex justify-between text-xs text-muted">
            <span>{t('planner.milestone.progressOf', { progress: shown, elapsed: row.elapsed })}</span>
            <span>
              {m.start} → {m.end}
            </span>
          </div>
          {row.error && <p className="rounded-lg bg-warning-soft px-3 py-2 text-xs text-warning">{t('planner.milestone.countFailed', { message: row.error })}</p>}
        </div>

        {m.source.kind === 'manual' && (
          <>
            <SectionTitle>{t('planner.detail.progress')}</SectionTitle>
            <div className="mx-4 flex items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3">
              <input type="range" min={0} max={100} step={5} value={shown} onChange={(e) => setProgress(Number(e.target.value))} aria-label={t('planner.milestone.progress')} className="min-w-0 flex-1 accent-[var(--color-accent)]" />
              <span className="w-12 text-right font-mono text-sm">{shown}%</span>
              <button type="button" disabled={progress === null || busy} onClick={() => void saveProgress()} className="h-9 rounded-lg bg-accent px-3 text-sm font-medium text-accent-fg disabled:opacity-45">
                {t('planner.detail.save')}
              </button>
            </div>
          </>
        )}

        <SectionTitle>{t('planner.detail.source')}</SectionTitle>
        <div className="mx-4 rounded-xl border border-border bg-surface">
          <Row>
            <div className="text-sm">{t(sourceLabel)}</div>
            {m.source.kind === 'tracker' && <div className="mt-0.5 font-mono text-xs text-muted">{m.source.query}</div>}
            {row.counts && <div className="mt-0.5 text-xs text-muted">{t('planner.detail.countsValue', { done: row.counts.done, total: row.counts.total, inProgress: row.counts.inProgress, todo: row.counts.todo })}</div>}
          </Row>
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
            <InlineConfirm question={t('planner.milestone.confirmDelete', { name: m.name })} yes={t('planner.milestone.remove', { name: m.name })} danger onNo={() => setDeleting(false)} onYes={() => (setDeleting(false), void remove())} />
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
