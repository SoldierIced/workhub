import { ChevronDown, ChevronRight, TriangleAlert } from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  alertRulesOf,
  appOptions,
  DEFAULT_REMINDER_LEAD_MINUTES,
  healthAlertSettingsOf,
  notificationsPaused,
  parseThresholds,
  pausedIndefinitely,
  pauseUntil,
  PR_EVENT_KINDS,
  TRAY_POPOVER_MEETING_COUNTS,
  type AppOptions,
  type HealthAlertKind,
  type PausePreset,
  type Profile,
  type QuietHours,
  type TrayPopoverOptions
} from '@workhub/core'
import type { ConfigSnapshot, Platform } from '@shared/api'
import { Button, Input, Select, Switch } from '../../components/atoms'
import { Card, SwitchRow, useToast } from '../../components/molecules'
import { useI18n } from '../../i18n/I18nProvider'
import type { MessageKey } from '../../i18n/translate'
import { SEVERITY_LABEL } from '../../lib/metricAlerts'
import { PR_KIND_HINT, PR_KIND_LABEL } from '../../lib/prEvents'
import { useOsNotificationsOff } from '../NotificationMasterRow'
import { TRAY_POPOVER_BLOCKS } from '../NotificationExtraSettings'
import { ROW_HIGHLIGHT_MS } from './focusRow'
import { NOTIFICATION_ROW_IDS, prRowId } from './notifications-index'
import type { Run } from './run'
import { SettingRow, SettingsGroup } from './SettingsLayout'
import { saveProfilePatch } from './shared'

export type ProfileTab = 'folders' | 'screens' | 'agents' | 'sessions'

export interface NotificationsAlertsSectionProps {
  snap: ConfigSnapshot
  run: Run
  /** The `data-setting-id` of the row to scroll to on open (a search result). */
  initialId?: string
  platform: Platform
  onOpenProfile: (profileId: string, tab: ProfileTab) => void
}

type FlagOption = 'notifyReplied' | 'notifyNeedsAnswer' | 'notifyError' | 'notifyHealth' | 'notifyMetricAlerts' | 'notifyFlowMaps' | 'notifyTickets' | 'notifyMeetings' | 'notifySlack' | 'notifyAutomations'

/** The environment-state kinds and the service kinds of Health: one matrix row each. */
const ENV_KINDS = ['degraded', 'unreachable', 'recovered'] as const satisfies readonly HealthAlertKind[]
const SERVICE_KINDS = ['stoppedReporting', 'podDown', 'errorsWorsening'] as const satisfies readonly HealthAlertKind[]

const HOURS = Array.from({ length: 24 }, (_, h) => h)
const DEFAULT_QUIET: QuietHours = { startHour: 22, endHour: 7 }
const hour = (h: number) => `${String(h).padStart(2, '0')}:00`

const BADGE_HINT: Record<Platform, MessageKey> = { mac: 'settings.appBadgeMac', windows: 'settings.appBadgeWindows', linux: 'settings.appBadgeLinux' }
const PAUSE_PRESETS: readonly (readonly [PausePreset, MessageKey])[] = [
  ['hour', 'settings.pauseHour'],
  ['tomorrow', 'settings.pauseTomorrow'],
  ['indefinite', 'notifAlerts.pauseIndefinite']
]
const MENU_ITEM = 'flex h-8 cursor-default select-none items-center gap-2 rounded-sm px-2 text-base outline-none data-[highlighted]:bg-accent-soft data-[disabled]:opacity-45'


/**
 * Settings → Notifications and alerts: whether Workhub notifies you, about what (one row per
 * source) and when not. App-wide values are edited here; the ones kept per profile (Health
 * thresholds, metric severity, map limits, meeting lead time, quiet hours) show each profile's
 * value and open that profile: nothing here writes to "the active profile" behind your back.
 */
export function NotificationsAlertsSection({ snap, run, initialId, platform, onOpenProfile }: NotificationsAlertsSectionProps) {
  const { t } = useI18n()
  const options = appOptions(snap.config)
  const editable = !snap.loadError
  const profiles = snap.config.profiles
  const save = (patch: Partial<AppOptions>) => run(() => window.hub.config.saveOptions(patch))
  const [prOpen, setPrOpen] = useState(() => initialId?.startsWith(`${NOTIFICATION_ROW_IDS.pullRequests}.`) ?? false)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!initialId || !root.current) return
    const row = root.current.querySelector<HTMLElement>(`[data-setting-id="${CSS.escape(initialId)}"]`)
    if (!row) return
    row.scrollIntoView({ behavior: 'smooth', block: 'center' })
    const mark = ['ring-2', 'ring-accent', 'bg-accent-soft/40']
    row.classList.add(...mark)
    const timer = window.setTimeout(() => row.classList.remove(...mark), ROW_HIGHLIGHT_MS)
    return () => window.clearTimeout(timer)
  }, [initialId])

  const flag = (option: FlagOption, label: string) => (
    <Switch checked={options[option]} disabled={!editable} aria-label={t('alertsSettings.notifyFor', { alert: label })} onChange={(on) => void save({ [option]: on })} />
  )
  const open = (id: string) => onOpenProfile(id, 'screens')

  const healthProfiles = profiles.filter((p) => p.modules.health)
  const flowProfiles = profiles.filter((p) => p.modules.flowMaps)
  const planProfiles = profiles.filter((p) => p.modules.planner)
  const prToggles = options.notifyPrEvents
  const prOn = PR_EVENT_KINDS.filter((k) => prToggles[k]).length
  const budget = options.usageBudget

  return (
    <div ref={root} className="flex flex-col gap-6" data-testid="settings-notifications-alerts">
      <MasterRow options={options} editable={editable} save={save} />

      <SettingsGroup title={t('notifAlerts.what.title')} help={t('notifAlerts.what.help')} footnote={t('notifAlerts.what.footnote')}>
        <table className="w-full text-sm" data-testid="notifications-matrix">
          <thead className="text-left text-xs text-muted">
            <tr>
              <th className="py-2 font-medium">{t('notifAlerts.col.when')}</th>
              <th className="w-20 py-2 font-medium">{t('alertsSettings.col.notify')}</th>
              <th className="w-56 py-2 font-medium">{t('alertsSettings.col.threshold')}</th>
            </tr>
          </thead>
          <tbody data-testid="notifications-group-sessions">
            <GroupHeading title={t('notifAlerts.group.sessions')} />
            <MatrixRow id={NOTIFICATION_ROW_IDS.sessionsReplied} label={t('notifAlerts.row.replied')} hint={t('notifAlerts.row.repliedHint')} notify={flag('notifyReplied', t('notifAlerts.row.replied'))} />
            <MatrixRow id={NOTIFICATION_ROW_IDS.sessionsNeedsAnswer} label={t('notifAlerts.row.needsAnswer')} notify={flag('notifyNeedsAnswer', t('notifAlerts.row.needsAnswer'))} />
            <MatrixRow id={NOTIFICATION_ROW_IDS.sessionsError} label={t('notifAlerts.row.error')} notify={flag('notifyError', t('notifAlerts.row.error'))} />
          </tbody>

          <tbody data-testid="notifications-group-pull-requests">
            <GroupHeading title={t('notifAlerts.group.pullRequests')} />
            <tr id={NOTIFICATION_ROW_IDS.pullRequests} data-setting-id={NOTIFICATION_ROW_IDS.pullRequests} data-settings-row className="border-t border-border">
              <td className="py-2.5 pr-3">
                <button
                  type="button"
                  className="flex items-start gap-1.5 text-left"
                  aria-expanded={prOpen}
                  aria-label={t(prOpen ? 'notifAlerts.pr.hide' : 'notifAlerts.pr.show')}
                  data-testid="notifications-pr-toggle"
                  onClick={() => setPrOpen((o) => !o)}
                >
                  {prOpen ? <ChevronDown className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden /> : <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />}
                  <span className="min-w-0">
                    <span className="block text-base">{t('notifAlerts.row.pullRequests')}</span>
                    {!prOpen && <span className="block text-xs text-subtle">{PR_EVENT_KINDS.map((k) => t(PR_KIND_LABEL[k])).join(' · ')}</span>}
                  </span>
                </button>
              </td>
              <td className="py-2.5 pr-3 text-xs text-muted" colSpan={2} data-testid="notifications-pr-summary">
                {t('notifAlerts.pr.summary', { on: prOn, total: PR_EVENT_KINDS.length })}
              </td>
            </tr>
            {prOpen &&
              PR_EVENT_KINDS.map((kind) => {
                const label = t(PR_KIND_LABEL[kind])
                return (
                  <MatrixRow
                    key={kind}
                    id={prRowId(kind)}
                    indent
                    label={label}
                    hint={t(PR_KIND_HINT[kind])}
                    notify={
                      <Switch
                        checked={prToggles[kind]}
                        disabled={!editable}
                        aria-label={t('alertsSettings.notifyFor', { alert: label })}
                        onChange={(on) => void save({ notifyPrEvents: { ...prToggles, [kind]: on } })}
                      />
                    }
                  />
                )
              })}
          </tbody>

          <tbody data-testid="notifications-group-agents">
            <GroupHeading title={t('notifAlerts.group.agents')} />
            <MatrixRow
              id={NOTIFICATION_ROW_IDS.usage}
              label={t('notifAlerts.row.usage')}
              hint={t('notifAlerts.row.usageHint')}
              notify={<Switch checked={budget.alerts} disabled={!editable} aria-label={t('alertsSettings.notifyFor', { alert: t('notifAlerts.row.usage') })} onChange={(on) => void save({ usageBudget: { ...budget, alerts: on } })} />}
              threshold={<UsageThresholds value={budget.thresholds} disabled={!editable || !budget.alerts} onCommit={(thresholds) => void save({ usageBudget: { ...budget, thresholds } })} />}
            />
          </tbody>

          <tbody data-testid="notifications-group-health">
            <GroupHeading
              title={t('notifAlerts.group.health')}
              detail={healthProfiles.length ? t('notifAlerts.group.healthProfiles', { profiles: healthProfiles.map((p) => p.name).join(', ') }) : t('notifAlerts.group.healthNone')}
            />
            <MatrixRow
              id={NOTIFICATION_ROW_IDS.healthEnvironments}
              label={t('notifAlerts.row.healthEnvironments')}
              hint={t('notifAlerts.row.healthEnvironmentsHint')}
              notify={flag('notifyHealth', t('notifAlerts.group.health'))}
              notifySpan={2}
              threshold={<ProfileValues rowId={NOTIFICATION_ROW_IDS.healthEnvironments} profiles={healthProfiles} value={(p) => envSummary(p, t)} onOpen={open} />}
            />
            <MatrixRow
              id={NOTIFICATION_ROW_IDS.healthServices}
              label={t('notifAlerts.row.healthServices')}
              hint={t('notifAlerts.row.healthServicesHint')}
              notify={null}
              threshold={<ProfileValues rowId={NOTIFICATION_ROW_IDS.healthServices} profiles={healthProfiles} value={(p) => servicesSummary(p, t)} onOpen={open} />}
            />
            <MatrixRow
              id={NOTIFICATION_ROW_IDS.metrics}
              label={t('notifAlerts.row.metrics')}
              hint={t('notifAlerts.row.metricsHint')}
              notify={flag('notifyMetricAlerts', t('notifAlerts.row.metrics'))}
              threshold={
                <ProfileValues
                  rowId={NOTIFICATION_ROW_IDS.metrics}
                  profiles={healthProfiles}
                  value={(p) => t('notifAlerts.thr.from', { severity: t(SEVERITY_LABEL[alertRulesOf(p.health?.alertRules).notifyMinSeverity]) })}
                  onOpen={open}
                />
              }
            />
            <MatrixRow
              id={NOTIFICATION_ROW_IDS.flowMaps}
              label={t('notifAlerts.row.flowMaps')}
              hint={t('notifAlerts.row.flowMapsHint')}
              notify={flag('notifyFlowMaps', t('notifAlerts.row.flowMaps'))}
              threshold={<ProfileValues rowId={NOTIFICATION_ROW_IDS.flowMaps} profiles={flowProfiles} value={() => t('notifAlerts.thr.perMap')} onOpen={open} />}
            />
          </tbody>

          <tbody data-testid="notifications-group-work">
            <GroupHeading title={t('notifAlerts.group.work')} />
            <MatrixRow id={NOTIFICATION_ROW_IDS.tickets} label={t('notifAlerts.row.tickets')} notify={flag('notifyTickets', t('notifAlerts.row.tickets'))} />
            <MatrixRow
              id={NOTIFICATION_ROW_IDS.meetings}
              label={t('notifAlerts.row.meetings')}
              hint={t('notifAlerts.row.meetingsHint')}
              notify={flag('notifyMeetings', t('notifAlerts.row.meetings'))}
              threshold={
                <ProfileValues
                  rowId={NOTIFICATION_ROW_IDS.meetings}
                  profiles={planProfiles}
                  value={(p) => t('notifAlerts.thr.minutes', { count: p.planner?.reminderLeadMinutes ?? DEFAULT_REMINDER_LEAD_MINUTES })}
                  onOpen={open}
                />
              }
            />
            <MatrixRow id={NOTIFICATION_ROW_IDS.slack} label={t('notifAlerts.row.slack')} notify={flag('notifySlack', t('notifAlerts.row.slack'))} />
            <MatrixRow id={NOTIFICATION_ROW_IDS.automations} label={t('notifAlerts.row.automations')} notify={flag('notifyAutomations', t('notifAlerts.row.automations'))} />
          </tbody>
        </table>
      </SettingsGroup>

      <QuietHours profiles={profiles} editable={editable} run={run} onOpenProfile={open} />

      <SettingsGroup title={t('notifAlerts.icon.title')} help={t('help.general.appBadge')}>
        <div id={NOTIFICATION_ROW_IDS.badge} data-setting-id={NOTIFICATION_ROW_IDS.badge}>
          <SwitchRow label={t('settings.appBadge')} hint={t(BADGE_HINT[platform])}>
            <Switch checked={options.showAppBadge} disabled={!editable} aria-label={t('settings.appBadge')} onChange={(on) => void save({ showAppBadge: on })} />
          </SwitchRow>
        </div>
        {platform !== 'linux' && <PanelChips current={options.trayPopover} editable={editable} save={(patch) => void save({ trayPopover: { ...options.trayPopover, ...patch } })} />}
      </SettingsGroup>
    </div>
  )
}

type T = ReturnType<typeof useI18n>['t']

/** The environment-state kinds of a profile: all on reads "in the profile", else how many are on. */
function envSummary(p: Profile, t: T): string {
  const s = healthAlertSettingsOf(p.health?.alerts)
  const on = ENV_KINDS.filter((k) => s[k].notify).length
  return on === ENV_KINDS.length ? t('notifAlerts.thr.inProfile') : t('notifAlerts.thr.kindsOn', { on, total: ENV_KINDS.length })
}

/** The service kinds of a profile: their thresholds ("10 min · 3× a typical day") and how many are on. */
function servicesSummary(p: Profile, t: T): string {
  const s = healthAlertSettingsOf(p.health?.alerts)
  const parts: string[] = []
  if (s.stoppedReporting.threshold !== undefined) parts.push(t('notifAlerts.thr.minutes', { count: s.stoppedReporting.threshold }))
  if (s.errorsWorsening.threshold !== undefined) parts.push(t('notifAlerts.thr.factor', { count: s.errorsWorsening.threshold }))
  if (!parts.length) parts.push(t('notifAlerts.thr.envDefault'))
  const on = SERVICE_KINDS.filter((k) => s[k].notify).length
  if (on !== SERVICE_KINDS.length) parts.push(t('notifAlerts.thr.kindsOn', { on, total: SERVICE_KINDS.length }))
  return parts.join(' · ')
}

/** The header: the master switch, a test notification and the pause, in one row. */
function MasterRow({ options, editable, save }: { options: AppOptions; editable: boolean; save: (patch: Partial<AppOptions>) => Promise<boolean> }) {
  const { t, formatDate } = useI18n()
  const toast = useToast()
  const osOff = useOsNotificationsOff()
  const [testing, setTesting] = useState(false)
  const paused = notificationsPaused(options, Date.now())
  const pause = (until: number) => void save({ notificationsPausedUntil: until })
  const sendTest = async () => {
    setTesting(true)
    try {
      const r = await window.hub.systemNotifications.test(t('notify.testBody'))
      if (r.outcome === 'shown') toast(t('notify.testShown'))
      else if (r.outcome === 'failed') toast(t('notify.testFailed', { error: r.error }), 'danger')
      else toast(t('notify.testTimeout'), 'danger')
    } finally {
      setTesting(false)
    }
  }
  const pausedText = paused
    ? pausedIndefinitely(options.notificationsPausedUntil)
      ? t('settings.pausedIndefinitely')
      : t('settings.pausedUntil', { time: formatDate(options.notificationsPausedUntil!, { hour: '2-digit', minute: '2-digit' }) })
    : null
  return (
    <section className="flex flex-col gap-2 rounded-lg" data-settings-group="">
      <Card className="divide-y divide-border px-4">
        <div id={NOTIFICATION_ROW_IDS.master} data-setting-id={NOTIFICATION_ROW_IDS.master} data-settings-row className="flex flex-wrap items-center gap-3 py-3">
          <div className="min-w-0 flex-1">
            <span className="block text-base">{t('notifAlerts.master')}</span>
            <p className="text-xs text-subtle">{pausedText ?? t('notifAlerts.masterHint')}</p>
          </div>
          <Switch checked={options.notificationsEnabled} disabled={!editable} aria-label={t('notifAlerts.master')} onChange={(on) => void save({ notificationsEnabled: on })} />
          <Button size="sm" disabled={testing} data-testid="notifications-test" title={t('notify.testHint')} onClick={() => void sendTest()}>
            {t('notify.test')}
          </Button>
          {paused ? (
            <Button size="sm" disabled={!editable} data-testid="notifications-resume" onClick={() => pause(0)}>
              {t('settings.resume')}
            </Button>
          ) : (
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <Button size="sm" disabled={!editable} data-testid="notifications-pause" aria-label={t('notifAlerts.pauseLabel')}>
                  {t('notifAlerts.pause')}
                  <ChevronDown className="size-3.5" aria-hidden />
                </Button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content align="end" sideOffset={6} className="z-50 min-w-44 animate-fade-in rounded-md border border-border bg-surface-raised p-1 shadow-lg">
                  {PAUSE_PRESETS.map(([preset, label]) => (
                    <DropdownMenu.Item key={preset} className={MENU_ITEM} onSelect={() => pause(pauseUntil(preset, new Date()))}>
                      {t(label)}
                    </DropdownMenu.Item>
                  ))}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          )}
        </div>
        {osOff && (
          <div role="alert" data-testid="notifications-os-warning" className="flex items-center gap-3 py-3">
            <TriangleAlert className="size-4 shrink-0 text-warning" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-base">{t('notify.osOff')}</p>
              <p className="text-xs text-subtle">{t('notify.osOffHint')}</p>
            </div>
            <Button size="sm" onClick={() => window.hub.systemNotifications.openSystemSettings()}>
              {t('notify.turnOn')}
            </Button>
          </div>
        )}
      </Card>
    </section>
  )
}

function GroupHeading({ title, detail }: { title: string; detail?: string }) {
  return (
    <tr className="border-t border-border">
      <th colSpan={3} scope="colgroup" className="pt-4 pb-1 text-left text-xs font-semibold text-muted">
        {title}
        {detail && <span className="ml-2 font-normal text-subtle">· {detail}</span>}
      </th>
    </tr>
  )
}

/** One source: what happens, its switch (`null`: shares the row above's) and its threshold ("—" when it has none). */
function MatrixRow({ id, label, hint, notify, notifySpan, threshold, indent }: { id: string; label: string; hint?: string; notify: ReactNode | null; notifySpan?: number; threshold?: ReactNode; indent?: boolean }) {
  return (
    <tr id={id} data-setting-id={id} data-settings-row className="border-t border-border">
      <td className={indent ? 'py-2 pr-3 pl-6' : 'py-2.5 pr-3'}>
        <span className="block text-base">{label}</span>
        {hint && <span className="block text-xs text-subtle">{hint}</span>}
      </td>
      {notify !== null && (
        <td className="py-2.5 pr-3" rowSpan={notifySpan}>
          {notify}
        </td>
      )}
      <td className="py-2.5">{threshold ?? <span className="text-subtle">—</span>}</td>
    </tr>
  )
}

/** A per-profile value: read-only here, each one opens its profile where it is edited. */
function ProfileValues({ rowId, profiles, value, onOpen }: { rowId: string; profiles: Profile[]; value: (p: Profile) => string; onOpen: (profileId: string) => void }) {
  const { t } = useI18n()
  if (!profiles.length) return <span className="text-xs text-subtle">{t('notifAlerts.thr.noProfile')}</span>
  return (
    <span className="flex flex-col items-start gap-0.5">
      {profiles.map((p) => {
        const v = value(p)
        return (
          <Button key={p.id} size="sm" variant="ghost" className="-ml-2.5" data-testid={`${rowId}.profile.${p.id}`} aria-label={t('notifAlerts.openProfile', { profile: p.name, value: v })} onClick={() => onOpen(p.id)}>
            <span className="text-muted">{p.name}</span>
            <span>{v}</span>
            <ChevronRight className="size-3.5 text-subtle" aria-hidden />
          </Button>
        )
      })}
    </span>
  )
}

/** The usage thresholds, comma separated, saved when the field loses focus or on Enter. */
function UsageThresholds({ value, disabled, onCommit }: { value: readonly number[]; disabled: boolean; onCommit: (thresholds: number[]) => void }) {
  const { t } = useI18n()
  const stored = value.join(', ')
  const [draft, setDraft] = useState(stored)
  useEffect(() => setDraft(stored), [stored])
  const commit = (text: string) => {
    const parsed = parseThresholds(text)
    // Nothing readable typed: keep the stored thresholds instead of clearing them.
    if (!parsed.length && text.trim() !== '') return setDraft(stored)
    setDraft(parsed.join(', '))
    if (parsed.join(',') !== value.join(',')) onCommit(parsed)
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <Input
        aria-label={t('notifAlerts.thresholdsFor')}
        title={t('agentUsage.settings.thresholdsHint')}
        className="w-28"
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => commit(e.currentTarget.value)}
        onKeyDown={(e) => e.key === 'Enter' && commit(e.currentTarget.value)}
      />
      <span className="text-xs text-subtle">%</span>
    </span>
  )
}

/**
 * Quiet hours are kept per profile. With one profile they are edited here, on that profile by id;
 * with several, each profile's value is listed with a link to it.
 */
function QuietHours({ profiles, editable, run, onOpenProfile }: { profiles: Profile[]; editable: boolean; run: Run; onOpenProfile: (profileId: string) => void }) {
  const { t } = useI18n()
  const range = (q: QuietHours | null | undefined) => (q ? t('alertsSettings.quiet.range', { from: hour(q.startHour), to: hour(q.endHour) }) : t('alertsSettings.quiet.off'))
  const only = profiles.length === 1 ? profiles[0]! : null
  const saveQuiet = (profileId: string, quietHours: QuietHours | null) => void saveProfilePatch(run, profileId, (p) => ({ ...p, alerts: { ...p.alerts, quietHours } }))
  const options = HOURS.map((h) => ({ value: String(h), label: hour(h) }))
  return (
    <SettingsGroup title={t('notifAlerts.quiet.title')} help={t('notifAlerts.quiet.help')} footnote={t('alertsSettings.quiet.footnote')}>
      <div id={NOTIFICATION_ROW_IDS.quiet} data-setting-id={NOTIFICATION_ROW_IDS.quiet}>
        {profiles.length === 0 && <p className="py-3 text-sm text-subtle">{t('notifAlerts.quiet.none')}</p>}
        {only && (
          <>
            <SettingRow label={t('alertsSettings.quiet.on')} hint={range(only.alerts?.quietHours)}>
              <div className="flex justify-end">
                <Switch checked={!!only.alerts?.quietHours} disabled={!editable} aria-label={t('alertsSettings.quiet.on')} onChange={(on) => saveQuiet(only.id, on ? DEFAULT_QUIET : null)} />
              </div>
            </SettingRow>
            {only.alerts?.quietHours && (
              <QuietRange quiet={only.alerts.quietHours} editable={editable} options={options} save={(q) => saveQuiet(only.id, q)} />
            )}
          </>
        )}
        {profiles.length > 1 &&
          profiles.map((p) => (
            <SettingRow key={p.id} label={t('notifAlerts.quiet.perProfile', { profile: p.name })} hint={range(p.alerts?.quietHours)}>
              <div className="flex justify-end">
                <Button size="sm" variant="ghost" data-testid={`${NOTIFICATION_ROW_IDS.quiet}.profile.${p.id}`} aria-label={t('notifAlerts.openProfile', { profile: p.name, value: p.alerts?.quietHours ? range(p.alerts.quietHours) : t('notifAlerts.quiet.offShort') })} onClick={() => onOpenProfile(p.id)}>
                  {p.name}
                  <ChevronRight className="size-3.5 text-subtle" aria-hidden />
                </Button>
              </div>
            </SettingRow>
          ))}
      </div>
    </SettingsGroup>
  )
}

function QuietRange({ quiet, editable, options, save }: { quiet: QuietHours; editable: boolean; options: { value: string; label: string }[]; save: (q: QuietHours) => void }) {
  const { t } = useI18n()
  return (
    <>
      <SettingRow label={t('alertsSettings.quiet.from')}>
        <Select aria-label={t('alertsSettings.quiet.from')} value={String(quiet.startHour)} disabled={!editable} options={options} onChange={(v) => save({ ...quiet, startHour: Number(v) })} />
      </SettingRow>
      <SettingRow label={t('alertsSettings.quiet.to')} hint={quiet.startHour === quiet.endHour ? t('alertsSettings.quiet.same') : undefined}>
        <Select aria-label={t('alertsSettings.quiet.to')} value={String(quiet.endHour)} disabled={!editable} options={options} onChange={(v) => save({ ...quiet, endHour: Number(v) })} />
      </SettingRow>
    </>
  )
}

/** The blocks of the menu bar panel as chips, in the order the panel draws them, and how many meetings it lists. */
function PanelChips({ current, editable, save }: { current: TrayPopoverOptions; editable: boolean; save: (patch: Partial<TrayPopoverOptions>) => void }) {
  const { t } = useI18n()
  return (
    <div id={NOTIFICATION_ROW_IDS.panel} data-setting-id={NOTIFICATION_ROW_IDS.panel} data-settings-row className="flex flex-col gap-2 py-3">
      <div className="min-w-0">
        <span className="block text-base">{t('notifAlerts.panel.label')}</span>
        <p className="text-xs text-subtle">{t('settings.trayPopoverNote')}</p>
      </div>
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t('notifAlerts.panel.label')}>
        {TRAY_POPOVER_BLOCKS.map(([block, label, hint]) => {
          const on = current[block]
          return (
            <Button key={block} size="sm" variant={on ? 'primary' : 'secondary'} aria-pressed={on} title={t(hint)} disabled={!editable} data-testid={`notifications-panel-${block}`} onClick={() => save({ [block]: !on })}>
              {block === 'meetings' && on ? t('notifAlerts.panel.meetingsWithCount', { count: current.meetingCount }) : t(label)}
            </Button>
          )
        })}
        {current.meetings && (
          <Select
            className="w-20"
            aria-label={t('settings.trayPopover.meetingCount')}
            value={String(current.meetingCount)}
            disabled={!editable}
            onChange={(v) => save({ meetingCount: Number(v) as TrayPopoverOptions['meetingCount'] })}
            options={TRAY_POPOVER_MEETING_COUNTS.map((n) => ({ value: String(n), label: String(n) }))}
          />
        )}
      </div>
    </div>
  )
}
