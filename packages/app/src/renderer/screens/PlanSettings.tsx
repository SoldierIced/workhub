import { Plus, RotateCcw, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import {
  BRIEF_PLACEHOLDERS,
  DEFAULT_BRIEF_TEMPLATE,
  DEFAULT_INBOX_DESCRIPTION_TEMPLATE,
  DEFAULT_MILESTONE_MARGIN,
  INBOX_TEMPLATE_PLACEHOLDERS,
  ISSUE_PRIORITIES,
  type IssuePriority,
  isValidRuleRegex,
  MAX_LEAD_MINUTES,
  newRuleId,
  plannerSettings,
  unknownPlaceholders,
  type MeetingRule,
  type Profile,
  type Result,
  type SecretChange,
  type WorkhubConfig
} from '@workhub/core'
import type { ConfigSnapshot } from '@shared/api'
import type { CalendarTestResult } from '@shared/plan-api'
import { Button, Input, Select, Switch, Textarea } from '../components/atoms'
import { Card, CardBody, CardHeader, EmptyState, Field, SwitchRow } from '../components/molecules'
import { useUnsavedForm } from '../components/organisms/UnsavedChanges'
import { useI18n } from '../i18n/I18nProvider'
import type { MessageKey } from '../i18n/translate'
import {
  CALENDAR_FAILURE_KEY,
  calendarToForm,
  clampLead,
  emptyRuleForm,
  formToCalendar,
  formToPerson,
  formToRule,
  looksLikeCalendarUrl,
  personId,
  personToForm,
  PLAN_LEAD_CHOICES,
  PLAN_REFRESH_CHOICES,
  ruleToForm,
  type CalendarForm,
  type PersonForm,
  type RuleForm
} from '../lib/plan'
import { CRITICALITY_PRESET, formToInboxSettings, inboxSettingsToForm, type InboxSettingsForm } from '../lib/planner'
import { uniqueConnectionId } from '../lib/tickets'
import { isDirty, type SaveOutcome } from '../lib/unsavedChanges'
import { PersonFields } from './plan/PersonFields'

type Run = (op: () => Promise<Result<WorkhubConfig>>) => Promise<boolean>

/** The part of a profile's Plan setup this tab edits in one form (calendars are saved with their connection). */
interface PlannerForm {
  calendarIds: string[]
  refreshMinutes: number
  reminderLeadMinutes: number
  rules: RuleForm[]
  briefTemplate: string
  people: PersonForm[]
  inbox: InboxSettingsForm
}

function plannerForm(profile: Profile | undefined): PlannerForm {
  const s = plannerSettings(profile)
  return {
    calendarIds: s.calendarIds,
    refreshMinutes: s.refreshMinutes,
    reminderLeadMinutes: s.reminderLeadMinutes,
    rules: s.rules.map(ruleToForm),
    briefTemplate: s.briefTemplate,
    people: s.people.map(personToForm),
    inbox: inboxSettingsToForm(s, s.milestoneMargin ?? DEFAULT_MILESTONE_MARGIN)
  }
}

/** Settings → Plan: the active profile's calendars, reminders, meeting rules, brief prompt and people. */
export function PlanSettings({ snap, run }: { snap: ConfigSnapshot; run: Run }) {
  const { t } = useI18n()
  const profile = snap.config.profiles.find((p) => p.id === snap.config.activeProfileId)
  const calendars = snap.config.connections.filter((c) => c.kind === 'calendar')
  const [form, setForm] = useState<PlannerForm>(() => plannerForm(profile))
  const [baseline, setBaseline] = useState<PlannerForm>(form)
  const [problem, setProblem] = useState<MessageKey | null>(null)
  const [editing, setEditing] = useState<CalendarForm | null>(null)
  const [demo, setDemo] = useState(false)

  useEffect(() => {
    const next = plannerForm(profile)
    setForm(next)
    setBaseline(next)
    setEditing(null)
    setProblem(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.id])
  useEffect(() => {
    if (profile) void window.hub.plan.get(profile.id).then((v) => setDemo(v.state === 'demo'), () => undefined)
  }, [profile?.id])

  const save = useRef<() => Promise<SaveOutcome>>(async () => ({ ok: true }))
  useUnsavedForm({
    dirty: profile !== undefined && isDirty(baseline, form),
    draft: form,
    save: () => save.current(),
    discard: () => setForm(baseline)
  })

  if (!profile) return <EmptyState compact title={t('plan.settings.noProfile')} />
  const editable = !snap.loadError
  const saveProfile = (patch: (p: Profile) => Profile) => run(() => window.hub.config.saveProfile(patch(profile)))

  save.current = async () => {
    const rules = form.rules.map(formToRule)
    const badRegex = rules.some((r) => r.match.titleRegex && !isValidRuleRegex(r.match.titleRegex))
    const nameless = form.people.some((p) => !p.name.trim())
    const gap: MessageKey | null = badRegex ? 'plan.settings.badRegex' : nameless ? 'plan.person.nameRequired' : null
    if (gap) {
      setProblem(gap)
      return { ok: false, problem: t(gap) }
    }
    setProblem(null)
    const planner = {
      ...plannerSettings(profile),
      calendarIds: form.calendarIds,
      refreshMinutes: form.refreshMinutes,
      reminderLeadMinutes: form.reminderLeadMinutes,
      rules,
      briefTemplate: form.briefTemplate,
      people: form.people.map(formToPerson),
      inbox: formToInboxSettings(form.inbox),
      milestoneMargin: Math.min(100, Math.max(0, Math.round(form.inbox.margin) || 0))
    }
    if (!(await saveProfile((p) => ({ ...p, planner })))) return { ok: false }
    setBaseline(form)
    return { ok: true }
  }

  /** Calendars change the stored profile at once (with their connection), so both form and baseline follow. */
  const setCalendarIds = (ids: string[]) => {
    setForm((f) => ({ ...f, calendarIds: ids }))
    setBaseline((b) => ({ ...b, calendarIds: ids }))
  }
  const removeCalendar = async (id: string) => {
    if (plannerSettings(profile).calendarIds.includes(id)) {
      const ids = plannerSettings(profile).calendarIds.filter((x) => x !== id)
      if (!(await saveProfile((p) => ({ ...p, planner: { ...plannerSettings(p), calendarIds: ids } })))) return
      setCalendarIds(ids)
    }
    if (await run(() => window.hub.config.deleteConnection(id))) setEditing(null)
  }

  const setRule = (index: number, patch: Partial<RuleForm>) => setForm((f) => ({ ...f, rules: f.rules.map((r, i) => (i === index ? { ...r, ...patch } : r)) }))
  const addRule = (action: MeetingRule['action']) => setForm((f) => ({ ...f, rules: [...f.rules, emptyRuleForm(newRuleId(f.rules.map((r) => r.id)), action)] }))
  const removeRule = (index: number) => setForm((f) => ({ ...f, rules: f.rules.filter((_, i) => i !== index) }))
  const setPerson = (index: number, patch: Partial<PersonForm>) => setForm((f) => ({ ...f, people: f.people.map((p, i) => (i === index ? { ...p, ...patch } : p)) }))
  const setInbox = (patch: Partial<InboxSettingsForm>) => setForm((f) => ({ ...f, inbox: { ...f.inbox, ...patch } }))
  const setLevel = (index: number, patch: Partial<{ name: string; priority: IssuePriority }>) => setInbox({ criticalities: form.inbox.criticalities.map((c, i) => (i === index ? { ...c, ...patch } : c)) })
  const trackers = snap.config.connections.filter((c) => c.kind === 'tracker')
  const automations = (snap.config.automations ?? []).filter((a) => a.profileId === null || a.profileId === profile.id)
  const unknown = unknownPlaceholders(form.briefTemplate)

  const ruleList = (action: MeetingRule['action']) => (
    <Card>
      <CardHeader
        title={t(action === 'remind' ? 'plan.settings.reminderRules' : 'plan.settings.briefRules')}
        help={t(action === 'remind' ? 'plan.settings.reminderRulesHelp' : 'plan.settings.briefRulesHelp')}
        actions={
          <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" aria-hidden />} onClick={() => addRule(action)} disabled={!editable}>
            {t('plan.settings.addRule')}
          </Button>
        }
      />
      <CardBody className="flex flex-col gap-3">
        {form.rules.every((r) => r.action !== action) && <p className="text-sm text-muted">{t(action === 'remind' ? 'plan.settings.noReminderRules' : 'plan.settings.noBriefRules')}</p>}
        {form.rules.map((r, i) =>
          r.action !== action ? null : (
            <details key={r.id} open={!r.name} className="rounded-md border border-border">
              <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-base font-medium">
                <span className="flex-1">{r.name || t('plan.settings.ruleName')}</span>
                <span className="text-xs text-subtle">{t('plan.settings.ruleLeadShort', { minutes: r.leadMinutes })}</span>
                <span onClick={(e) => e.stopPropagation()}>
                  <Switch checked={r.enabled} aria-label={t('plan.settings.ruleEnabled')} onChange={(on) => setRule(i, { enabled: on })} />
                </span>
                <button
                  type="button"
                  aria-label={t('plan.settings.removeRule', { name: r.name || r.id })}
                  className="inline-flex size-6 items-center justify-center rounded-sm text-subtle hover:bg-danger-soft hover:text-danger"
                  onClick={(e) => {
                    e.preventDefault()
                    removeRule(i)
                  }}
                >
                  <Trash2 className="size-3.5" aria-hidden />
                </button>
              </summary>
              <div className="grid grid-cols-2 gap-3 border-t border-border p-3">
                <Field label={t('plan.settings.ruleName')}>
                  <Input value={r.name} onChange={(e) => setRule(i, { name: e.target.value })} placeholder={action === 'brief' ? 'Client calls' : 'Stand-ups'} />
                </Field>
                <Field label={t('plan.settings.ruleLead')} hint={t('plan.settings.ruleLeadHint')}>
                  <Input type="number" min={0} max={MAX_LEAD_MINUTES} value={r.leadMinutes} onChange={(e) => setRule(i, { leadMinutes: clampLead(Number(e.target.value)) })} />
                </Field>
                <Field label={t('plan.settings.titleContains')} hint={t('plan.settings.listHint')}>
                  <Input value={r.titleContains} onChange={(e) => setRule(i, { titleContains: e.target.value })} placeholder="standup, daily" />
                </Field>
                <Field label={t('plan.settings.titleRegex')} error={r.titleRegex.trim() && !isValidRuleRegex(r.titleRegex) ? t('plan.settings.badRegex') : undefined}>
                  <Input value={r.titleRegex} onChange={(e) => setRule(i, { titleRegex: e.target.value })} placeholder="^1:1" spellCheck={false} className="font-mono" />
                </Field>
                <Field label={t('plan.settings.attendeeEmails')} hint={t('plan.settings.listHint')}>
                  <Input value={r.attendeeEmails} onChange={(e) => setRule(i, { attendeeEmails: e.target.value })} placeholder="ana@example.com" spellCheck={false} />
                </Field>
                <Field label={t('plan.settings.minAttendees')}>
                  <Input type="number" min={0} value={r.minAttendees} onChange={(e) => setRule(i, { minAttendees: e.target.value })} />
                </Field>
                <div className="col-span-2">
                  <SwitchRow label={t('plan.settings.recurringOnly')}>
                    <Switch checked={r.recurringOnly} onChange={(on) => setRule(i, { recurringOnly: on })} />
                  </SwitchRow>
                </div>
                {action === 'remind' ? (
                  <Field label={t('plan.settings.ruleMessage')} hint={t('plan.settings.ruleMessageHint')} className="col-span-2">
                    <Input value={r.message} onChange={(e) => setRule(i, { message: e.target.value })} />
                  </Field>
                ) : (
                  <Field label={t('plan.settings.ruleAutomation')} hint={t('plan.settings.ruleAutomationHint')} className="col-span-2">
                    <Select
                      value={r.automationId}
                      onChange={(v) => setRule(i, { automationId: v })}
                      options={[{ value: '', label: t('plan.settings.ruleAutomationNone') }, ...automations.map((a) => ({ value: a.id, label: a.name || a.id }))]}
                    />
                  </Field>
                )}
              </div>
            </details>
          )
        )}
      </CardBody>
    </Card>
  )

  return (
    <div className="flex flex-col gap-4">
      <p className="text-base text-muted">{t('plan.settings.intro')}</p>
      {demo && <p className="rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">{t('plan.settings.demoNote')}</p>}
      {problem && (
        <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
          {t(problem)}
        </p>
      )}

      <Card className="px-4">
        <SwitchRow label={t('plan.settings.module')} hint={`${t('plan.settings.moduleHint')} (${profile.name})`}>
          <Switch checked={profile.modules.planner} disabled={!editable} onChange={(on) => void saveProfile((p) => ({ ...p, modules: { ...p.modules, planner: on } }))} />
        </SwitchRow>
      </Card>

      <Card>
        <CardHeader
          title={t('plan.settings.calendars')}
          help={t('plan.settings.calendarsHelp')}
          actions={
            <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" aria-hidden />} onClick={() => setEditing(calendarToForm(undefined))} disabled={!editable}>
              {t('plan.settings.addCalendar')}
            </Button>
          }
        />
        <CardBody className="flex flex-col gap-3">
          <p className="rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">{t('plan.settings.secretWarning')}</p>
          {calendars.length === 0 && !editing && <p className="text-sm text-muted">{t('plan.settings.noCalendars')}</p>}
          {calendars.map((c) => (
            <div key={c.id} className="flex items-center gap-3 rounded-md border border-border px-3 py-2">
              <Switch
                checked={form.calendarIds.includes(c.id)}
                aria-label={t('plan.settings.readCalendar', { name: c.name || c.id })}
                disabled={!editable}
                onChange={(on) => setForm((f) => ({ ...f, calendarIds: on ? [...f.calendarIds, c.id] : f.calendarIds.filter((x) => x !== c.id) }))}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{c.name || c.id}</p>
                <p className="truncate text-xs text-muted">{snap.connectionsWithSecret.includes(c.id) ? t('plan.settings.addressStored') : t('plan.settings.addressMissing')}</p>
              </div>
              <Button size="sm" variant="ghost" onClick={() => setEditing(calendarToForm(c))}>
                {t('plan.settings.editCalendar')}
              </Button>
              <Button size="sm" variant="ghost" aria-label={t('plan.settings.removeCalendar', { name: c.name || c.id })} icon={<Trash2 className="size-3.5" aria-hidden />} onClick={() => void removeCalendar(c.id)} disabled={!editable} />
            </div>
          ))}
          {editing && (
            <CalendarEditor
              key={editing.id ?? 'new'}
              initial={editing}
              stored={editing.id !== null && snap.connectionsWithSecret.includes(editing.id)}
              takenIds={snap.config.connections.map((c) => c.id)}
              run={run}
              onSaved={(id, created) => {
                if (created && !plannerSettings(profile).calendarIds.includes(id)) {
                  const ids = [...plannerSettings(profile).calendarIds, id]
                  void saveProfile((p) => ({ ...p, planner: { ...plannerSettings(p), calendarIds: ids } })).then((ok) => ok && setCalendarIds(ids))
                }
                setEditing(null)
              }}
              onCancel={() => setEditing(null)}
            />
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={t('plan.settings.reminders')} help={t('plan.settings.remindersHelp')} />
        <CardBody className="grid grid-cols-2 gap-4">
          <Field label={t('plan.settings.refresh')} hint={t('plan.settings.refreshHint')}>
            <Select value={String(form.refreshMinutes)} onChange={(v) => setForm((f) => ({ ...f, refreshMinutes: Number(v) }))} options={PLAN_REFRESH_CHOICES.map((m) => ({ value: String(m), label: t('plan.settings.minutes', { count: m }) }))} />
          </Field>
          <Field label={t('plan.settings.defaultLead')} hint={t('plan.settings.defaultLeadHint')}>
            <Select
              value={String(form.reminderLeadMinutes)}
              onChange={(v) => setForm((f) => ({ ...f, reminderLeadMinutes: Number(v) }))}
              options={[...new Set([...PLAN_LEAD_CHOICES, form.reminderLeadMinutes])].sort((a, b) => a - b).map((m) => ({ value: String(m), label: m === 0 ? t('plan.settings.leadOff') : t('plan.settings.minutesBefore', { count: m }) }))}
            />
          </Field>
        </CardBody>
      </Card>

      {ruleList('remind')}
      {ruleList('brief')}

      <Card>
        <CardHeader
          title={t('plan.settings.template')}
          help={t('plan.settings.templateHelp')}
          actions={
            <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" aria-hidden />} onClick={() => setForm((f) => ({ ...f, briefTemplate: '' }))} disabled={!form.briefTemplate}>
              {t('plan.settings.templateReset')}
            </Button>
          }
        />
        <CardBody className="flex flex-col gap-2">
          <Textarea rows={12} value={form.briefTemplate || DEFAULT_BRIEF_TEMPLATE} onChange={(e) => setForm((f) => ({ ...f, briefTemplate: e.target.value === DEFAULT_BRIEF_TEMPLATE ? '' : e.target.value }))} className="font-mono text-sm" spellCheck={false} />
          <p className="text-xs text-subtle">{t('plan.settings.placeholders', { list: BRIEF_PLACEHOLDERS.map((p) => `{${p}}`).join(' ') })}</p>
          {unknown.length > 0 && <p className="text-xs text-warning">{t('plan.settings.unknownPlaceholders', { list: unknown.map((p) => `{${p}}`).join(' ') })}</p>}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={t('planner.settings.inbox')} help={t('planner.settings.inboxHelp')} />
        <CardBody className="grid grid-cols-2 gap-4">
          <Field label={t('planner.settings.areas')} hint={t('planner.settings.areasHint')} className="col-span-2">
            <Input value={form.inbox.areas} onChange={(e) => setInbox({ areas: e.target.value })} placeholder="Backend, Mobile, Support" />
          </Field>
          <div className="col-span-2 flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <span className="flex-1 text-sm font-medium text-muted">{t('planner.settings.criticalities')}</span>
              {form.inbox.criticalities.length === 0 && (
                <Button size="sm" variant="ghost" disabled={!editable} onClick={() => setInbox({ criticalities: CRITICALITY_PRESET.map((c) => ({ ...c })) })}>
                  {t('planner.settings.criticalityPreset')}
                </Button>
              )}
              <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" aria-hidden />} disabled={!editable || form.inbox.criticalities.length >= 10} onClick={() => setInbox({ criticalities: [...form.inbox.criticalities, { name: '', priority: 3 }] })}>
                {t('planner.settings.addCriticality')}
              </Button>
            </div>
            <p className="text-xs text-subtle">{t('planner.settings.criticalitiesHint')}</p>
            {form.inbox.criticalities.map((c, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input value={c.name} aria-label={t('planner.settings.criticalityName')} placeholder={t('planner.settings.criticalityName')} onChange={(e) => setLevel(i, { name: e.target.value })} className="flex-1" />
                <Select
                  value={String(c.priority)}
                  aria-label={t('planner.settings.criticalityPriority')}
                  className="w-48"
                  onChange={(v) => setLevel(i, { priority: Number(v) as IssuePriority })}
                  options={ISSUE_PRIORITIES.map((p) => ({ value: String(p), label: t(`planner.settings.priority.${p}` as MessageKey) }))}
                />
                <Button size="sm" variant="ghost" aria-label={t('planner.settings.removeCriticality', { name: c.name || String(i + 1) })} icon={<Trash2 className="size-3.5" aria-hidden />} onClick={() => setInbox({ criticalities: form.inbox.criticalities.filter((_, j) => j !== i) })} />
              </div>
            ))}
          </div>
          <Field label={t('planner.settings.tracker')} hint={t('planner.settings.trackerHint')}>
            <Select value={form.inbox.trackerConnectionId} onChange={(v) => setInbox({ trackerConnectionId: v })} options={[{ value: '', label: t('planner.settings.trackerDefault') }, ...trackers.map((c) => ({ value: c.id, label: c.name || c.id }))]} />
          </Field>
          <Field label={t('planner.settings.project')} hint={t('planner.settings.projectHint')}>
            <Input value={form.inbox.project} onChange={(e) => setInbox({ project: e.target.value })} placeholder="PAY" spellCheck={false} />
          </Field>
          <Field label={t('planner.settings.taskType')} hint={t('planner.settings.issueTypeHint')}>
            <Input value={form.inbox.taskType} onChange={(e) => setInbox({ taskType: e.target.value })} placeholder="Task" />
          </Field>
          <Field label={t('planner.settings.bugType')} hint={t('planner.settings.issueTypeHint')}>
            <Input value={form.inbox.bugType} onChange={(e) => setInbox({ bugType: e.target.value })} placeholder="Bug" />
          </Field>
          <Field label={t('planner.settings.descriptionTemplate')} className="col-span-2">
            <Textarea rows={4} value={form.inbox.descriptionTemplate || DEFAULT_INBOX_DESCRIPTION_TEMPLATE} onChange={(e) => setInbox({ descriptionTemplate: e.target.value === DEFAULT_INBOX_DESCRIPTION_TEMPLATE ? '' : e.target.value })} className="font-mono text-sm" spellCheck={false} />
          </Field>
          <p className="col-span-2 -mt-2 text-xs text-subtle">{t('plan.settings.placeholders', { list: INBOX_TEMPLATE_PLACEHOLDERS.map((p) => `{${p}}`).join(' ') })}</p>
          <Field label={t('planner.settings.margin')} hint={t('planner.settings.marginHint')}>
            <Input type="number" min={0} max={100} value={form.inbox.margin} onChange={(e) => setInbox({ margin: Number(e.target.value) })} />
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title={t('plan.settings.people')}
          help={t('plan.settings.peopleHelp')}
          actions={
            <Button
              size="sm"
              variant="ghost"
              icon={<Plus className="size-3.5" aria-hidden />}
              disabled={!editable}
              onClick={() => setForm((f) => ({ ...f, people: [...f.people, personToForm({ id: personId(t('plan.people.newName'), f.people.map((p) => p.id)), name: '', emails: [] })] }))}
            >
              {t('plan.people.add')}
            </Button>
          }
        />
        <CardBody className="flex flex-col gap-3">
          {form.people.length === 0 && <p className="text-sm text-muted">{t('plan.people.empty')}</p>}
          {form.people.map((p, i) => (
            <details key={p.id} open={!p.name} className="rounded-md border border-border">
              <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-base font-medium">
                <span className="flex-1">{p.name || t('plan.person.name')}</span>
                <span className="truncate text-xs text-subtle">{p.emails}</span>
                <button
                  type="button"
                  aria-label={t('plan.people.remove', { name: p.name || p.id })}
                  className="inline-flex size-6 items-center justify-center rounded-sm text-subtle hover:bg-danger-soft hover:text-danger"
                  onClick={(e) => {
                    e.preventDefault()
                    setForm((f) => ({ ...f, people: f.people.filter((_, j) => j !== i) }))
                  }}
                >
                  <Trash2 className="size-3.5" aria-hidden />
                </button>
              </summary>
              <div className="border-t border-border p-3">
                <PersonFields form={p} onChange={(patch) => setPerson(i, patch)} nameError={problem === 'plan.person.nameRequired' && !p.name.trim() ? t('plan.person.nameRequired') : undefined} />
              </div>
            </details>
          ))}
        </CardBody>
      </Card>
    </div>
  )
}

/** Adds or edits one calendar connection: its name, its private address (never shown back) and its owner's address. */
function CalendarEditor({ initial, stored, takenIds, run, onSaved, onCancel }: { initial: CalendarForm; stored: boolean; takenIds: string[]; run: Run; onSaved: (id: string, created: boolean) => void; onCancel: () => void }) {
  const { t } = useI18n()
  const [form, setForm] = useState(initial)
  const [test, setTest] = useState<{ state: 'idle' | 'running' } | { state: 'done'; result: CalendarTestResult }>({ state: 'idle' })
  const [problem, setProblem] = useState<MessageKey | null>(null)
  const set = (patch: Partial<CalendarForm>) => {
    setForm((f) => ({ ...f, ...patch }))
    setTest({ state: 'idle' })
  }
  const id = form.id ?? uniqueConnectionId(form.name || 'calendar', takenIds)
  const secretChange = (): SecretChange => (form.secret.trim() ? { action: 'set', value: form.secret.trim() } : { action: 'keep' })
  const missing = (): MessageKey | null => {
    if (form.secret.trim() && !looksLikeCalendarUrl(form.secret)) return 'plan.settings.badAddress'
    if (!form.secret.trim() && !stored) return 'plan.settings.missingAddress'
    return null
  }

  const runTest = async () => {
    const gap = missing()
    if (gap) return setProblem(gap)
    setProblem(null)
    setTest({ state: 'running' })
    setTest({ state: 'done', result: await window.hub.plan.test(formToCalendar(form, id), secretChange()) })
  }
  const save = async (): Promise<SaveOutcome> => {
    const gap = missing()
    if (gap) {
      setProblem(gap)
      return { ok: false, problem: t(gap) }
    }
    setProblem(null)
    if (!(await run(() => window.hub.config.saveConnection(formToCalendar(form, id), secretChange())))) return { ok: false }
    onSaved(id, form.id === null)
    return { ok: true }
  }
  useUnsavedForm({ dirty: isDirty(initial, form), draft: form, save, discard: onCancel })

  return (
    <div className="flex flex-col gap-3 rounded-md border border-accent/40 p-3" data-testid="calendar-editor">
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('plan.settings.calendarName')}>
          <Input value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="Work calendar" />
        </Field>
        <Field label={t('plan.settings.ownerEmail')} hint={t('plan.settings.ownerEmailHint')}>
          <Input value={form.ownerEmail} onChange={(e) => set({ ownerEmail: e.target.value })} placeholder="me@example.com" spellCheck={false} />
        </Field>
        <Field label={t('plan.settings.address')} hint={t('plan.settings.addressHint')} className="col-span-2" error={problem ? t(problem) : undefined}>
          <Input type="password" value={form.secret} onChange={(e) => set({ secret: e.target.value })} placeholder={stored ? t('plan.settings.addressStoredPlaceholder') : 'https://calendar.example.com/…/basic.ics'} autoComplete="off" spellCheck={false} />
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
        <Button onClick={() => void runTest()} disabled={test.state === 'running'}>
          {test.state === 'running' ? t('plan.settings.testing') : t('plan.settings.test')}
        </Button>
        {test.state === 'done' && (
          <span role="status" className={test.result.ok ? 'text-sm text-success' : 'text-sm text-danger'}>
            {test.result.ok ? t('plan.settings.testOk', { upcoming: test.result.upcoming, total: test.result.total }) : `${t(CALENDAR_FAILURE_KEY[test.result.failure])}${test.result.detail ? ` (${test.result.detail})` : ''}`}
          </span>
        )}
        <span className="flex-1" />
        <Button variant="ghost" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button variant="primary" onClick={() => void save()}>
          {t('plan.settings.saveCalendar')}
        </Button>
      </div>
    </div>
  )
}
