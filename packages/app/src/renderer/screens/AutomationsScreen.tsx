import { Bot, Pencil, Play, Plus, Square, SquareArrowOutUpRight, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { newAutomation, prReviewsPreset, type AutomationDefinition, type AutomationRun, type EffectiveAgent, type Profile } from '@workhub/core'
import type { AutomationStatus } from '@shared/chat-api'
import { Badge, Button, IconButton, Spinner, Switch } from '../components/atoms'
import { Card, CardBody, CardHeader, EmptyState, useToast } from '../components/molecules'
import { useAutomations, useSlack } from '../chatStore'
import { refreshConfig } from '../configStore'
import { useI18n } from '../i18n/I18nProvider'
import { relativeTime } from '../lib/pullRequests'
import { AutomationEditor } from './automations/AutomationEditor'

const HEALTH_TONE = { off: 'neutral', idle: 'success', waiting: 'info', paused: 'warning', failing: 'danger', running: 'accent' } as const
const OUTCOME_TONE = { ok: 'success', error: 'danger', rateLimited: 'warning', timeout: 'danger', skipped: 'neutral', coalesced: 'neutral', stopped: 'neutral' } as const

export interface AutomationsScreenProps {
  profile: Profile | undefined
  agents: EffectiveAgent[]
  onOpenSession: (viewId: string) => void
}

/** Automations (⌘5): prompts sent to a dedicated session on a Slack message or a schedule, with their run log. */
export function AutomationsScreen({ profile, agents, onOpenSession }: AutomationsScreenProps) {
  const { t, locale } = useI18n()
  const toast = useToast()
  const snap = useAutomations()
  const slack = useSlack()
  const [editing, setEditing] = useState<AutomationDefinition | null>(null)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(timer)
  }, [])
  if (!snap) {
    return (
      <p className="flex items-center gap-2 p-8 text-sm text-muted" role="status">
        <Spinner />
      </p>
    )
  }
  const channels = slack?.settings.channels ?? []
  const defaultAgent = agents.find((a) => a.agent.id === 'claude')?.key ?? agents[0]?.key ?? 'claude'
  const folder = profile?.folders?.[0] ?? '~'

  const save = async (a: AutomationDefinition) => {
    const r = await window.hub.automations.save(a)
    if (!r.ok) toast(r.issues.map((i) => i.message).join('; '), 'danger')
    else void refreshConfig()
    return r.ok
  }
  const remove = async (id: string) => {
    const r = await window.hub.automations.remove(id)
    if (r.ok) void refreshConfig()
  }
  const open = async (id: string) => {
    const viewId = await window.hub.automations.openSession(id)
    if (viewId) onOpenSession(viewId)
    else toast(t('automations.noSession'), 'danger')
  }
  const fresh = () => crypto.randomUUID().slice(0, 8)

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 px-8 py-7">
      <header className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">{t('nav.automations')}</h1>
          <p className="mt-0.5 max-w-2xl text-base text-muted">{t('automations.subtitle')}</p>
        </div>
        <Button size="sm" variant="secondary" onClick={() => setEditing(prReviewsPreset(fresh(), { profileId: profile?.id ?? null, agentKey: defaultAgent, folder, channels }))}>
          {t('automations.preset.prReviews')}
        </Button>
        <Button size="sm" variant="primary" icon={<Plus className="size-3.5" aria-hidden />} onClick={() => setEditing(newAutomation(fresh(), { name: t('automations.newName'), profileId: profile?.id ?? null, agentKey: defaultAgent, folder }))}>
          {t('automations.new')}
        </Button>
      </header>

      {snap.automations.length === 0 ? (
        <EmptyState icon={<Bot className="size-6" aria-hidden />} title={t('automations.empty.title')} description={t('automations.empty.hint')} />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {snap.automations.map((s) => (
            <AutomationCard
              key={s.definition.id}
              status={s}
              now={now}
              channelName={(id) => channels.find((c) => c.id === id)?.name ?? id}
              onEdit={() => setEditing(structuredClone(s.definition))}
              onRemove={() => void remove(s.definition.id)}
              onOpen={() => void open(s.definition.id)}
            />
          ))}
        </div>
      )}

      <Card>
        <CardHeader title={t('automations.runs')} meta={String(snap.runs.length)} />
        <CardBody>
          {snap.runs.length === 0 && <p className="text-sm text-subtle">{t('automations.noRuns')}</p>}
          <ul className="flex flex-col gap-1 text-sm" data-testid="automation-runs">
            {snap.runs.slice(0, 30).map((r) => (
              <RunRow key={r.id} run={r} now={now} locale={locale} />
            ))}
          </ul>
        </CardBody>
      </Card>

      <AutomationEditor automation={editing} agents={agents} channels={channels} onClose={() => setEditing(null)} onSave={save} />
    </div>
  )
}

function AutomationCard({ status: s, now, channelName, onEdit, onRemove, onOpen }: { status: AutomationStatus; now: number; channelName: (id: string) => string; onEdit: () => void; onRemove: () => void; onOpen: () => void }) {
  const { t, locale } = useI18n()
  const a = s.definition
  const triggers = [
    ...(a.triggers.chatChannelIds.length ? [t('automations.trigger.chat', { channels: a.triggers.chatChannelIds.map((id) => `#${channelName(id)}`).join(', ') })] : []),
    ...(a.triggers.intervalMinutes ? [t('automations.trigger.interval', { minutes: a.triggers.intervalMinutes })] : [])
  ]
  return (
    <Card data-testid="automation-card">
      <CardHeader
        title={a.name}
        meta={<Badge tone={HEALTH_TONE[s.health]}>{t(`automations.health.${s.health}`)}</Badge>}
        actions={<Switch checked={a.enabled} onChange={(on) => void window.hub.automations.setEnabled(a.id, on)} aria-label={t('automations.field.enabled')} />}
      />
      <CardBody className="flex flex-col gap-2">
        <code className="truncate rounded bg-surface-raised px-2 py-1 text-sm" title={a.prompt}>
          {a.prompt || t('automations.noPrompt')}
        </code>
        <p className="text-sm text-muted">{triggers.length ? triggers.join(' · ') : t('automations.trigger.manual')}</p>
        <p className="text-xs text-subtle">
          {t(a.sessionPolicy === 'reuse' ? 'automations.policy.reuse' : 'automations.policy.newEachRun')} · {a.folder} ·{' '}
          {t('automations.counts', { window: s.startedInWindow, max: a.limits.maxRuns, minutes: a.limits.perMinutes, today: s.startedToday })}
        </p>
        {!s.active && <p className="text-xs text-warning">{t('automations.moduleOff')}</p>}
        {s.waitReason && (
          <p className="text-xs text-subtle">
            {t('automations.waiting', { reason: t(`automations.reason.${s.waitReason.split('.')[0]}` as 'automations.reason.limit'), time: s.waitUntil ? relativeTime(s.waitUntil, now, locale) : '' })}
          </p>
        )}
        {s.lastError && <p className="truncate text-xs text-danger">{s.lastError}</p>}
        <div className="flex items-center gap-1">
          {s.health === 'running' ? (
            <Button size="sm" variant="secondary" icon={<Square className="size-3.5" aria-hidden />} onClick={() => void window.hub.automations.stop(a.id)}>
              {t('automations.stop')}
            </Button>
          ) : (
            <Button size="sm" icon={<Play className="size-3.5" aria-hidden />} onClick={() => void window.hub.automations.runNow(a.id)}>
              {t('automations.runNow')}
            </Button>
          )}
          {s.session && <IconButton size="sm" label={t('automations.openSession')} icon={<SquareArrowOutUpRight className="size-3.5" />} onClick={onOpen} />}
          <IconButton size="sm" label={t('automations.edit')} icon={<Pencil className="size-3.5" />} onClick={onEdit} />
          <IconButton size="sm" label={t('common.delete')} icon={<Trash2 className="size-3.5" />} onClick={onRemove} />
        </div>
      </CardBody>
    </Card>
  )
}

function RunRow({ run: r, now, locale }: { run: AutomationRun; now: number; locale: string }) {
  const { t } = useI18n()
  const detail = r.detail ? (r.detail.startsWith('timeout:') ? t('automations.detail.timeout', { minutes: r.detail.slice(8) }) : DETAIL_KEYS.has(r.detail) ? t(`automations.detail.${r.detail}` as 'automations.detail.paused') : r.detail) : ''
  return (
    <li className="flex items-center gap-2">
      <Badge tone={OUTCOME_TONE[r.outcome]}>{t(`automations.outcome.${r.outcome}`)}</Badge>
      <span className="font-medium">{r.automationName}</span>
      <span className="text-subtle">{t(`automations.triggerKind.${r.trigger}`)}</span>
      {r.merged > 0 && <span className="text-xs text-subtle">{t('automations.merged', { count: r.merged })}</span>}
      <span className="min-w-0 flex-1 truncate text-muted" title={detail}>
        {detail}
      </span>
      <span className="text-xs text-subtle">{relativeTime(r.endedAt ?? r.startedAt ?? r.queuedAt, now, locale)}</span>
    </li>
  )
}

const DETAIL_KEYS = new Set(['window.days', 'window.hours', 'limit.window', 'limit.day', 'mergedIntoPending', 'sessionClosed', 'neverIdle', 'stoppedByUser', 'moduleOff', 'paused', 'usage'])
