import { useEffect, useState, type ReactNode } from 'react'
import { DEFAULT_HEALTH_REFRESH_MINUTES, type Profile } from '@workhub/core'
import { Badge, Select, Switch } from '../../components/atoms'
import { Card } from '../../components/molecules'
import { useUnsavedForm } from '../../components/organisms/UnsavedChanges'
import { useI18n } from '../../i18n/I18nProvider'
import { platformShortcutText } from '../../lib/shortcuts'
import { isDirty, type SaveOutcome } from '../../lib/unsavedChanges'
import { AiReviewSection } from '../AiReviewSettings'
import { FlowLimitsGroup } from '../alerts/FlowLimits'
import { HealthKindsGroup, MetricsGroup, QuietHoursGroup } from '../AlertsSettings'
import { FlowMapsSettings } from '../FlowMapsSettings'
import { HealthSettings } from '../HealthSettings'
import { PlanSettings } from '../PlanSettings'
import { SlackArchiveField, SlackSettings } from '../SlackSettings'
import { TrackerSettings } from '../TrackerSettings'
import { SCREEN_ROWS, type ScreenRow } from './profileSummary'
import { PullRequestsFilterFields } from './PullRequestsFilter'
import type { ProfileScreen } from './sections'
import { Disclosure, saveProfilePatch, type SectionProps } from './shared'

type Picks = Pick<Profile, 'modules' | 'connections' | 'slackArchiveMinutes' | 'pullRequests'>
const picksOf = (p: Profile): Picks => ({
  modules: { ...p.modules },
  connections: { ...p.connections },
  ...(p.slackArchiveMinutes !== undefined ? { slackArchiveMinutes: p.slackArchiveMinutes } : {}),
  ...(p.pullRequests ? { pullRequests: p.pullRequests } : {})
})

export interface ProfileScreensTabProps extends SectionProps {
  profileId: string
  /** A screen to open (and point at); a new `at` opens it again. */
  openScreen?: { key: ProfileScreen; at: number } | null
  /** A "Fix" asked for the Health connection's secret. */
  focusHealthSecret?: boolean
  /** A "Fix" asked for this tracker. */
  trackerId?: string
}

/**
 * Settings → Profiles › a profile › Screens: one row per screen with its switch and the connection
 * it reads on the same row, and under it that screen's settings, all for this profile. The
 * switches and connections are one form (one save bar entry); each screen's settings save as they
 * always did, with this profile's id.
 */
export function ProfileScreensTab({ snap, run, profileId, openScreen, focusHealthSecret, trackerId }: ProfileScreensTabProps) {
  const { t } = useI18n()
  const profile = snap.config.profiles.find((p) => p.id === profileId)
  const [form, setForm] = useState<Picks | null>(() => (profile ? picksOf(profile) : null))
  const [baseline, setBaseline] = useState<Picks | null>(form)
  const [open, setOpen] = useState<ReadonlySet<ProfileScreen>>(() => new Set(openScreen ? [openScreen.key] : []))
  useEffect(() => {
    if (openScreen) setOpen((s) => new Set([...s, openScreen.key]))
  }, [openScreen])
  const save = async (): Promise<SaveOutcome> => {
    if (!profile || !form) return { ok: true }
    const next = (p: Profile): Profile => {
      const out: Profile = { ...p, modules: form.modules, connections: form.connections }
      if (form.slackArchiveMinutes !== undefined) out.slackArchiveMinutes = form.slackArchiveMinutes
      else delete out.slackArchiveMinutes
      if (form.pullRequests) out.pullRequests = form.pullRequests
      else delete out.pullRequests
      return out
    }
    if (!(await saveProfilePatch(run, profile.id, next))) return { ok: false }
    setBaseline(form)
    return { ok: true }
  }
  useUnsavedForm({ dirty: form !== null && isDirty(baseline, form), draft: form, save, discard: () => setForm(baseline) })
  if (!profile || !form) return null
  const editable = !snap.loadError

  // Read the profile fresh: another form of Settings may have saved it a moment ago.
  const saveProfile = (change: (p: Profile) => Profile) => void saveProfilePatch(run, profile.id, change)
  const withHealth = (p: Profile, patch: Partial<NonNullable<Profile['health']>>): Profile => ({ ...p, health: { refreshMinutes: DEFAULT_HEALTH_REFRESH_MINUTES, environments: [], ...p.health, ...patch } })

  const settingsOf = (key: ProfileScreen): ReactNode => {
    switch (key) {
      case 'pullRequests':
        return (
          <PullRequestsFilterFields
            value={form.pullRequests}
            editable={editable}
            onChange={(pullRequests) => {
              const { pullRequests: _old, ...rest } = form
              setForm(pullRequests ? { ...rest, pullRequests } : rest)
            }}
          />
        )
      case 'tickets':
        return <TrackerSettings snap={snap} run={run} initialId={trackerId} profileId={profile.id} />
      case 'slack':
        return (
          <div className="flex flex-col gap-4">
            <SlackArchiveField value={form.slackArchiveMinutes} onChange={(minutes) => setForm({ ...form, slackArchiveMinutes: minutes })} />
            <p className="text-sm text-muted">{t('settings.slackAppWide')}</p>
            <SlackSettings snap={snap} run={run} />
          </div>
        )
      case 'health':
        return (
          <div className="flex flex-col gap-6">
            <HealthSettings snap={snap} run={run} focusSecret={focusHealthSecret} profileId={profile.id} />
            <HealthKindsGroup profile={profile} editable={editable} save={(alerts) => saveProfile((p) => withHealth(p, { alerts }))} />
            <MetricsGroup profile={profile} editable={editable} save={(alertRules) => saveProfile((p) => withHealth(p, { alertRules }))} />
            <QuietHoursGroup profile={profile} editable={editable} save={(quietHours) => saveProfile((p) => ({ ...p, alerts: { ...p.alerts, quietHours } }))} />
          </div>
        )
      case 'flowMaps':
        return (
          <div className="flex flex-col gap-6">
            <FlowMapsSettings snap={snap} run={run} profileId={profile.id} />
            <FlowLimitsGroup profile={profile} editable={editable} />
          </div>
        )
      case 'plan':
        return <PlanSettings snap={snap} run={run} profileId={profile.id} />
      case 'aiReview':
        return <AiReviewSection snap={snap} run={run} profileId={profile.id} />
      default:
        return null
    }
  }

  const connectionSelect = (row: ScreenRow) => {
    const kind = row.kind!
    return (
      <Select
        className="w-48"
        aria-label={t('settingsV2.screens.connection', { screen: t(row.label) })}
        value={form.connections[kind] ?? ''}
        disabled={!editable}
        onChange={(v) => {
          const connections = { ...form.connections }
          if (v) connections[kind] = v
          else delete connections[kind]
          setForm({ ...form, connections })
        }}
        options={[{ value: '', label: t('common.none') }, ...snap.config.connections.filter((c) => c.kind === kind).map((c) => ({ value: c.id, label: c.name || c.id }))]}
      />
    )
  }
  const controls = (row: ScreenRow): ReactNode => (
    <>
      {row.kind && connectionSelect(row)}
      {row.key === 'flowMaps' && <Badge tone="neutral">{t('settingsV2.screens.usesHealth')}</Badge>}
      {row.module && (
        <Switch
          aria-label={t(row.label)}
          checked={form.modules[row.module]}
          disabled={!editable}
          onChange={(on) => setForm({ ...form, modules: { ...form.modules, [row.module!]: on } })}
        />
      )}
    </>
  )

  return (
    <div className="flex flex-col gap-3" data-testid="settings-modules">
      <p className="px-1 text-sm text-muted">{t('settingsV2.screens.intro')}</p>
      {SCREEN_ROWS.map((row) => (
        // Each screen is a group of its own, so `#health` points at it.
        <section key={row.key} className="rounded-lg transition-[opacity,filter,box-shadow] duration-500" data-settings-group={row.key} data-testid={`settings-module-${row.key}`}>
          <Card className="px-4">
            {row.settings ? (
              <Disclosure
                label={t(row.label)}
                hint={platformShortcutText(t(row.hint), window.hub.platform)}
                controls={controls(row)}
                open={open.has(row.key)}
                onOpenChange={(on) => setOpen((s) => (on ? new Set([...s, row.key]) : new Set([...s].filter((k) => k !== row.key))))}
                testId={`screen-${row.key}`}
              >
                <div className="border-t border-border py-4">{settingsOf(row.key)}</div>
              </Disclosure>
            ) : (
              <div className="flex items-center justify-between gap-6 py-3" data-settings-row>
                <div className="min-w-0">
                  <span className="block text-base">{t(row.label)}</span>
                  <p className="text-xs text-subtle">{platformShortcutText(t(row.hint), window.hub.platform)}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">{controls(row)}</div>
              </div>
            )}
          </Card>
          {row.key === 'flowMaps' && form.modules.flowMaps && !form.modules.health && <p className="px-1 pt-1 text-xs text-warning">{t('flowMaps.settings.needsHealth')}</p>}
        </section>
      ))}
    </div>
  )
}
