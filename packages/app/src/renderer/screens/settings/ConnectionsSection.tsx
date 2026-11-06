import { ChevronDown, ChevronRight, Plus } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  appOptions,
  CALENDAR_CONNECTION_SETTINGS,
  findProvider,
  HEALTH_CONNECTION_SETTINGS,
  HEALTH_FLOOR_CHOICES,
  type Connection,
  type ConnectionKind,
  type SecretChange
} from '@workhub/core'
import type { ConfigSnapshot } from '@shared/api'
import { Button, Input, Select, Switch, Textarea } from '../../components/atoms'
import { Card, Field, HelpTip, SwitchRow } from '../../components/molecules'
import { DeleteButton, useUnsavedChanges, useUnsavedForm } from '../../components/organisms/UnsavedChanges'
import { useI18n } from '../../i18n/I18nProvider'
import type { MessageKey } from '../../i18n/translate'
import { connectionToForm, formToConnection, type ConnectionForm } from '../../lib/healthForm'
import { CALENDAR_FAILURE_KEY } from '../../lib/plan'
import { TRACKER_SETTINGS } from '../../lib/trackerSettings'
import { isDirty, type SaveOutcome } from '../../lib/unsavedChanges'
import { ProtectedBranchesRows } from '../ProtectedBranchesRows'
import { SlackSettings } from '../SlackSettings'
import { CONNECTIONS_ROW_IDS } from './connections-index'
import { connectionProblem, connectionToSave, connectionUses, groupConnections, newConnection, type ConnectionGroupId } from './connections-model'
import { ROW_HIGHLIGHT_MS } from './focusRow'
import type { Run } from './run'
import { fromLines, toLines, type SectionProps } from './shared'

const GROUP_TEXT: Record<ConnectionGroupId, { title: MessageKey; help: MessageKey; rowId: string; add: { provider: string; label: MessageKey }[] }> = {
  code: {
    title: 'settingsConnections.group.code',
    help: 'settingsConnections.group.codeHelp',
    rowId: CONNECTIONS_ROW_IDS.code,
    add: [
      { provider: 'github', label: 'settingsConnections.add.github' },
      { provider: 'gitlab', label: 'settingsConnections.add.gitlab' }
    ]
  },
  tickets: {
    title: 'settingsConnections.group.tickets',
    help: 'settingsConnections.group.ticketsHelp',
    rowId: CONNECTIONS_ROW_IDS.tickets,
    add: [
      { provider: 'jira', label: 'settingsConnections.add.jira' },
      { provider: 'linear', label: 'settingsConnections.add.linear' }
    ]
  },
  calendars: { title: 'settingsConnections.group.calendars', help: 'settingsConnections.group.calendarsHelp', rowId: CONNECTIONS_ROW_IDS.calendars, add: [{ provider: 'ics', label: 'settingsConnections.add.calendar' }] },
  slack: { title: 'settingsConnections.group.slack', help: 'settingsConnections.group.slackHelp', rowId: CONNECTIONS_ROW_IDS.slack, add: [] },
  health: { title: 'settingsConnections.group.health', help: 'settingsConnections.group.healthHelp', rowId: CONNECTIONS_ROW_IDS.health, add: [{ provider: 'elastic-apm', label: 'settingsConnections.add.health' }] }
}

/** What the section has open: one connection's form (`id` null: a new one of `provider`). */
type Editing = { id: string; kind: ConnectionKind } | { id: null; kind: ConnectionKind; provider: string } | null

/**
 * Settings → Connections: every service Workhub reads, grouped by kind (code, tickets, calendars,
 * Slack, Health), each connection with the profiles and screens that use it and its form in
 * place. The app-wide parts of a kind (the branches never deleted, the Slack watcher, how often
 * Health may read) are shown once in their group.
 */
export function ConnectionsSection({ snap, run, initialId }: SectionProps & { initialId?: string }) {
  const { t } = useI18n()
  const unsaved = useUnsavedChanges()
  const root = useRef<HTMLDivElement>(null)
  const config = snap.config
  const editable = !snap.loadError
  const initial = config.connections.find((c) => c.id === initialId)
  const [editing, setEditing] = useState<Editing>(initial ? { id: initial.id, kind: initial.kind } : null)
  const open = (next: Editing) => unsaved.requestLeave(() => setEditing(next))
  const close = () => setEditing(null)
  // A search result points at a row by its id: scroll to it and highlight it for a moment.
  useEffect(() => {
    if (!initialId || !root.current) return
    const row = root.current.querySelector<HTMLElement>(`[data-setting-id="${CSS.escape(initialId)}"]`)
    if (!row) return
    row.scrollIntoView({ block: 'center' })
    row.classList.add('ring-2', 'ring-accent', 'rounded-md')
    const timer = window.setTimeout(() => row.classList.remove('ring-2', 'ring-accent', 'rounded-md'), ROW_HIGHLIGHT_MS)
    return () => window.clearTimeout(timer)
  }, [initialId])

  const groups = groupConnections(config.connections)
  const editorFor = (c: Connection | null, kind: ConnectionKind, provider: string) => (
    <ConnectionEditor key={c?.id ?? `new:${provider}`} snap={snap} run={run} connection={c} kind={kind} provider={provider} focusSecret={c !== null && c.id === initialId} onClose={close} />
  )

  return (
    <div ref={root} className="flex flex-col gap-6" data-testid="connections-section">
      <p className="max-w-3xl px-1 text-sm text-muted">{t('settingsConnections.intro')}</p>
      {groups.map((g) => {
        const text = GROUP_TEXT[g.id]
        const adding = editing && editing.id === null && editing.kind === g.kind ? editing : null
        return (
          <section key={g.id} className="flex flex-col gap-2" data-setting-id={text.rowId} data-settings-group={g.id} data-testid="connections-group" data-group={g.id}>
            <div className="flex flex-wrap items-center gap-2 px-1">
              <h2 className="flex items-center gap-1.5 text-md font-semibold">
                {t(text.title)}
                <HelpTip text={t(text.help)} label={t(text.title)} />
              </h2>
              <span className="ml-auto flex flex-wrap gap-1.5">
                {text.add.map((a) => (
                  <Button key={a.provider} size="sm" variant="ghost" icon={<Plus className="size-3.5" aria-hidden />} disabled={!editable} onClick={() => open({ id: null, kind: g.kind, provider: a.provider })} data-testid={`connections-add-${a.provider}`}>
                    {t(a.label)}
                  </Button>
                ))}
              </span>
            </div>
            {(g.connections.length > 0 || adding || g.id !== 'slack') && (
              <Card className="flex flex-col divide-y divide-border px-4">
                {adding && <div className="py-3">{editorFor(null, g.kind, adding.provider)}</div>}
                {g.connections.length === 0 && !adding && <p className="py-3 text-sm text-subtle">{t('settingsConnections.none')}</p>}
                {g.connections.map((c) => {
                  const isOpen = editing?.id === c.id
                  return (
                    <div key={c.id} data-testid="connection-card" data-connection={c.id}>
                      <ConnectionRow connection={c} uses={<UsesLine snap={snap} id={c.id} />} expanded={isOpen} onToggle={() => open(isOpen ? null : { id: c.id, kind: c.kind })} />
                      {isOpen && <div className="pb-3">{editorFor(c, c.kind, c.provider)}</div>}
                    </div>
                  )
                })}
              </Card>
            )}
            {g.id === 'code' && (
              <div className="flex flex-col gap-1" data-setting-id={CONNECTIONS_ROW_IDS.protectedBranches} data-testid="connections-protected-branches">
                <h3 className="px-1 pt-1 text-sm font-semibold text-muted">{t('settingsConnections.protectedBranches')}</h3>
                <Card className="px-4">
                  <ProtectedBranchesRows config={config} editable={editable} run={run} />
                </Card>
              </div>
            )}
            {g.id === 'slack' && (
              <div className="flex flex-col gap-1" data-testid="connections-slack-watcher">
                <h3 className="px-1 pt-1 text-sm font-semibold text-muted">{t('settingsConnections.watchSlack')}</h3>
                <SlackSettings snap={snap} run={run} />
              </div>
            )}
            {g.id === 'health' && (
              <Card className="px-4 py-3" data-setting-id={CONNECTIONS_ROW_IDS.healthFloor} data-testid="connections-health-floor">
                <Field label={t('settingsConnections.healthFloor')} hint={t('health.settings.floorHint')} className="max-w-96">
                  <Select
                    aria-label={t('settingsConnections.healthFloor')}
                    value={String(appOptions(config).healthRefreshFloorMinutes)}
                    onChange={(v) => void run(() => window.hub.config.saveOptions({ healthRefreshFloorMinutes: Number(v) }))}
                    disabled={!editable}
                    options={HEALTH_FLOOR_CHOICES.map((m) => ({ value: String(m), label: t('health.settings.refreshMinutes', { count: m }) }))}
                  />
                </Field>
              </Card>
            )}
          </section>
        )
      })}
    </div>
  )
}

/** "Used by Acme web · Pull requests, Side project · Pull requests", or that no profile uses it. */
function UsesLine({ snap, id }: { snap: ConfigSnapshot; id: string }) {
  const { t } = useI18n()
  const uses = connectionUses(snap.config, id)
  return (
    <span data-testid="connection-used-by">
      {uses.length ? t('settingsConnections.usedBy', { uses: uses.map((u) => t('settingsConnections.useItem', { profile: u.profileName, screen: t(u.screen) })).join(', ') }) : t('settingsConnections.usedByNone')}
    </span>
  )
}

function ConnectionRow({ connection: c, uses, expanded, onToggle }: { connection: Connection; uses: ReactNode; expanded: boolean; onToggle: () => void }) {
  const { t } = useI18n()
  const name = c.name || c.id
  const provider = findProvider(c.provider)?.name ?? c.provider
  return (
    <div className="flex items-center gap-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="truncate text-base font-medium">{name}</div>
        <div className="truncate text-xs text-subtle">
          {[provider, c.endpoint].filter(Boolean).join(' · ')}
          <span className="block truncate">{uses}</span>
        </div>
      </div>
      <Button
        size="sm"
        variant="ghost"
        aria-expanded={expanded}
        aria-label={t('settingsConnections.editLabel', { name })}
        icon={expanded ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronRight className="size-3.5" aria-hidden />}
        onClick={onToggle}
      >
        {t('settingsConnections.edit')}
      </Button>
    </div>
  )
}

type TestState = { state: 'idle' | 'running' } | { state: 'ok' | 'failed'; text: string }

/**
 * One connection's form, with the fields its provider names (a tracker's site and project keys,
 * Elasticsearch's authentication and TLS…) and, for anything else, "Edit as text": every option
 * as key=value lines. The secret goes to the secret store.
 */
export function ConnectionEditor({
  snap,
  run,
  connection,
  kind,
  provider,
  focusSecret,
  onClose
}: {
  snap: ConfigSnapshot
  run: Run
  connection: Connection | null
  kind: ConnectionKind
  provider: string
  focusSecret?: boolean
  onClose: () => void
}) {
  const { t } = useI18n()
  const isNew = connection === null
  const [baseline, setBaseline] = useState<Connection>(() => connection ?? newConnection(kind, provider))
  const [draft, setDraft] = useState<Connection>(baseline)
  const [secret, setSecret] = useState('')
  const [clearSecret, setClearSecret] = useState(false)
  const [asText, setAsText] = useState(false)
  const [text, setText] = useState(() => toLines(baseline.settings))
  const [problem, setProblem] = useState<MessageKey | null>(null)
  const [test, setTest] = useState<TestState>({ state: 'idle' })
  const stored = connection !== null && snap.connectionsWithSecret.includes(connection.id)
  const takenIds = snap.config.connections.map((c) => c.id)
  const providerInfo = findProvider(draft.provider)

  const set = (patch: Partial<Connection>) => {
    setDraft((d) => ({ ...d, ...patch }))
    setProblem(null)
    setTest({ state: 'idle' })
  }
  const setSetting = (key: string, value: string) => set({ settings: { ...draft.settings, [key]: value } })
  const current = (): Connection => (asText ? { ...draft, settings: fromLines(text) } : draft)
  const secretChange = (): SecretChange => (clearSecret ? { action: 'clear' } : secret.trim() ? { action: 'set', value: secret.trim() } : { action: 'keep' })

  const save = async (): Promise<SaveOutcome> => {
    const c = current()
    const gap = connectionProblem(c, secret, stored && !clearSecret)
    if (gap) {
      setProblem(gap)
      return { ok: false, problem: t(gap) }
    }
    const next = connectionToSave(c, takenIds)
    if (!(await run(() => window.hub.config.saveConnection(next, secretChange())))) return { ok: false }
    setBaseline(next)
    setDraft(next)
    setText(toLines(next.settings))
    setSecret('')
    setClearSecret(false)
    return { ok: true }
  }
  const dirty = isDirty(baseline, current()) || secret !== '' || clearSecret
  useUnsavedForm({
    dirty,
    draft: { draft, text, secret, clearSecret },
    save,
    discard: () => {
      setDraft(baseline)
      setText(toLines(baseline.settings))
      setSecret('')
      setClearSecret(false)
    }
  })
  const saveNow = async () => {
    if ((await save()).ok) onClose()
  }

  const runTest = async () => {
    const c = current()
    const gap = connectionProblem(c, secret, stored)
    if (gap) return setTest({ state: 'failed', text: t(gap) })
    setTest({ state: 'running' })
    const probe = connectionToSave(c, takenIds)
    if (kind === 'calendar') {
      const r = await window.hub.plan.test(probe, secretChange())
      return setTest(r.ok ? { state: 'ok', text: t('plan.settings.testOk', { upcoming: r.upcoming, total: r.total }) } : { state: 'failed', text: `${t(CALENDAR_FAILURE_KEY[r.failure])}${r.detail ? ` (${r.detail})` : ''}` })
    }
    const r = kind === 'health' ? await window.hub.health.test(probe, secretChange()) : await window.hub.tickets.test(probe, secretChange())
    setTest(r.ok ? { state: 'ok', text: t('settingsConnections.testOk', { account: r.account }) } : { state: 'failed', text: t('settingsConnections.testFailed', { error: r.error }) })
  }

  const secretPlaceholder = stored ? t('settings.secretStored') : t('settings.secretNotSet')
  const secretInput = (label: string, hint?: string, placeholder = secretPlaceholder) => (
    <Field label={label} hint={hint} className="col-span-2">
      <Input type="password" aria-label={label} value={secret} autoFocus={focusSecret} onChange={(e) => setSecret(e.target.value)} placeholder={placeholder} autoComplete="off" spellCheck={false} />
    </Field>
  )
  const nameField = (placeholder: string) => (
    <Field label={t('settings.name')}>
      <Input aria-label={t('settings.name')} value={draft.name ?? ''} onChange={(e) => set({ name: e.target.value })} placeholder={placeholder} />
    </Field>
  )
  const health: ConnectionForm = connectionToForm(draft)
  const setHealth = (patch: Partial<ConnectionForm>) => {
    const next = formToConnection({ ...health, ...patch }, draft.id)
    const others = Object.fromEntries(Object.entries(draft.settings).filter(([k]) => !(Object.values(HEALTH_CONNECTION_SETTINGS) as string[]).includes(k)))
    set({ endpoint: next.endpoint, settings: { ...others, ...next.settings } })
  }
  const providerSelect = (choices: { value: string; label: string }[]) => (
    <Field label={t('settingsConnections.service')}>
      <Select aria-label={t('settingsConnections.service')} value={draft.provider} disabled={!isNew} onChange={(v) => set({ provider: v })} options={choices} />
    </Field>
  )

  const fields = (): ReactNode => {
    switch (kind) {
      case 'codeHost':
        return (
          <>
            {providerSelect([
              { value: 'github', label: 'GitHub' },
              { value: 'gitlab', label: 'GitLab' }
            ])}
            {nameField(draft.provider === 'gitlab' ? 'Acme GitLab' : 'Acme GitHub')}
            <Field label={t('settingsConnections.host')} hint={t('settingsConnections.hostHint', { host: providerInfo?.defaultEndpoint ?? '' })} className="col-span-2">
              <Input aria-label={t('settingsConnections.host')} value={draft.endpoint ?? ''} onChange={(e) => set({ endpoint: e.target.value })} placeholder={providerInfo?.defaultEndpoint ?? 'https://git.example.com'} spellCheck={false} />
            </Field>
            {secretInput(t('settingsConnections.token'), t('settingsConnections.tokenHintCode'))}
          </>
        )
      case 'tracker': {
        const jira = draft.provider === 'jira'
        return (
          <>
            {providerSelect([
              { value: 'jira', label: 'Jira' },
              { value: 'linear', label: 'Linear' }
            ])}
            {nameField(jira ? 'Team Jira' : 'Team Linear')}
            {jira && (
              <>
                <Field label={t('trackers.site')} hint={t('trackers.siteHint')}>
                  <Input aria-label={t('trackers.site')} value={draft.endpoint ?? ''} onChange={(e) => set({ endpoint: e.target.value })} placeholder="your-team.atlassian.net" spellCheck={false} autoComplete="off" />
                </Field>
                <Field label={t('trackers.email')}>
                  <Input aria-label={t('trackers.email')} type="email" value={draft.settings[TRACKER_SETTINGS.email] ?? ''} onChange={(e) => setSetting(TRACKER_SETTINGS.email, e.target.value)} placeholder="you@example.com" spellCheck={false} autoComplete="off" />
                </Field>
              </>
            )}
            {secretInput(jira ? t('trackers.token') : t('trackers.apiKey'), jira ? t('trackers.tokenHintJira') : t('trackers.tokenHintLinear'), stored ? t('trackers.tokenStored') : t('trackers.tokenNotSet'))}
            <Field label={t('trackers.projectKeys')} hint={t('trackers.projectKeysHint')}>
              <Input aria-label={t('trackers.projectKeys')} value={draft.settings[TRACKER_SETTINGS.projectKeys] ?? ''} onChange={(e) => setSetting(TRACKER_SETTINGS.projectKeys, e.target.value)} placeholder="ABC, WEB" spellCheck={false} />
            </Field>
            <Field label={t('trackers.ignoredStatuses')} hint={t('trackers.ignoredStatusesHint')}>
              <Input aria-label={t('trackers.ignoredStatuses')} value={draft.settings[TRACKER_SETTINGS.ignored] ?? ''} onChange={(e) => setSetting(TRACKER_SETTINGS.ignored, e.target.value)} placeholder="Blocked, On hold" />
            </Field>
          </>
        )
      }
      case 'calendar':
        return (
          <>
            {nameField('Work calendar')}
            <Field label={t('plan.settings.ownerEmail')} hint={t('plan.settings.ownerEmailHint')}>
              <Input aria-label={t('plan.settings.ownerEmail')} value={draft.settings[CALENDAR_CONNECTION_SETTINGS.ownerEmail] ?? ''} onChange={(e) => setSetting(CALENDAR_CONNECTION_SETTINGS.ownerEmail, e.target.value)} placeholder="me@example.com" spellCheck={false} />
            </Field>
            {secretInput(t('plan.settings.address'), t('plan.settings.addressHint'), stored ? t('plan.settings.addressStoredPlaceholder') : 'https://calendar.example.com/…/basic.ics')}
          </>
        )
      case 'health':
        return (
          <>
            {nameField('Elasticsearch')}
            <Field label={t('health.settings.url')} hint={t('health.settings.urlHint')}>
              <Input aria-label={t('health.settings.url')} value={health.url} onChange={(e) => setHealth({ url: e.target.value })} placeholder="https://elastic.example.com:9200" spellCheck={false} autoComplete="off" />
            </Field>
            <Field label={t('health.settings.auth')}>
              <Select
                aria-label={t('health.settings.auth')}
                value={health.auth}
                onChange={(v) => setHealth({ auth: v === 'basic' ? 'basic' : 'apiKey' })}
                options={[
                  { value: 'apiKey', label: t('health.settings.auth.apiKey') },
                  { value: 'basic', label: t('health.settings.auth.basic') }
                ]}
              />
            </Field>
            {health.auth === 'basic' && (
              <Field label={t('health.settings.username')}>
                <Input aria-label={t('health.settings.username')} value={health.username} onChange={(e) => setHealth({ username: e.target.value })} spellCheck={false} autoComplete="off" />
              </Field>
            )}
            {secretInput(health.auth === 'basic' ? t('health.settings.secret.basic') : t('health.settings.secret.apiKey'), undefined, stored ? t('health.settings.secretStored') : '')}
            <Field label={t('health.settings.tls')} help={t('help.health.tls')}>
              <Select
                aria-label={t('health.settings.tls')}
                value={health.tls}
                onChange={(v) => setHealth({ tls: v === 'pinned' || v === 'insecure' ? v : 'system' })}
                options={[
                  { value: 'system', label: t('health.settings.tls.system') },
                  { value: 'pinned', label: t('health.settings.tls.pinned') },
                  { value: 'insecure', label: t('health.settings.tls.insecure') }
                ]}
              />
            </Field>
            {health.tls === 'pinned' && (
              <Field label={t('health.settings.fingerprint')} hint={t('health.settings.fingerprintHint')}>
                <Input aria-label={t('health.settings.fingerprint')} value={health.fingerprint} onChange={(e) => setHealth({ fingerprint: e.target.value })} spellCheck={false} className="font-mono" />
              </Field>
            )}
            {health.tls === 'insecure' && <p className="col-span-2 rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">{t('health.settings.insecureWarning')}</p>}
          </>
        )
      default:
        return (
          <>
            {nameField('Slack')}
            <p className="col-span-2 text-sm text-subtle">{t('settingsConnections.chatNote')}</p>
          </>
        )
    }
  }

  const rawFields = (
    <>
      {isNew && (
        <Field label={t('settings.id')} help={t('help.id')}>
          <Input aria-label={t('settings.id')} value={draft.id} onChange={(e) => set({ id: e.target.value })} placeholder="acme-github" spellCheck={false} />
        </Field>
      )}
      {nameField(providerInfo?.name ?? '')}
      <Field label={providerInfo?.requiresEndpoint ? t('settings.endpointRequired') : t('settings.endpoint')} help={t('help.connection.endpoint')} className="col-span-2">
        <Input aria-label={t('settings.endpoint')} value={draft.endpoint ?? ''} onChange={(e) => set({ endpoint: e.target.value })} placeholder={providerInfo?.defaultEndpoint ?? 'https://acme.example.com'} spellCheck={false} />
      </Field>
      {secretInput(providerInfo?.requiresSecret ? t('settings.secretRequired') : t('settings.secret'), t('settings.secretHint'))}
      {stored && (
        <div className="col-span-2">
          <SwitchRow label={t('settings.clearSecret')}>
            <Switch checked={clearSecret} onChange={setClearSecret} />
          </SwitchRow>
        </div>
      )}
      <Field label={t('settings.settingsLines')} hint={t('settingsConnections.asTextHint')} className="col-span-2">
        <Textarea aria-label={t('settings.settingsLines')} rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder="scope=org:acme" spellCheck={false} />
      </Field>
    </>
  )

  const toggleText = () => {
    // The two views edit the same connection: the lines are read back into the fields and the other way round.
    if (asText) setDraft((d) => ({ ...d, settings: fromLines(text) }))
    else setText(toLines(draft.settings))
    setAsText(!asText)
  }
  const testable = kind === 'tracker' || kind === 'health' || kind === 'calendar'

  return (
    <div className="flex flex-col gap-4 rounded-md border border-accent/40 p-3" data-testid="connection-editor" data-kind={kind}>
      {isNew && <h3 className="text-base font-semibold">{t('settingsConnections.newTitle', { provider: providerInfo?.name ?? draft.provider })}</h3>}
      <div className="grid grid-cols-2 gap-4">{asText ? rawFields : fields()}</div>
      {problem && (
        <p role="alert" className="text-sm text-danger">
          {t(problem)}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
        <button type="button" className="text-sm font-medium text-muted hover:text-text" onClick={toggleText} data-testid="connection-as-text">
          {t(asText ? 'settingsConnections.asFields' : 'settingsConnections.asText')}
        </button>
        {testable && (
          <Button size="sm" onClick={() => void runTest()} disabled={test.state === 'running'}>
            {t(test.state === 'running' ? 'settingsConnections.testing' : 'settingsConnections.test')}
          </Button>
        )}
        {(test.state === 'ok' || test.state === 'failed') && (
          <span role="status" className={test.state === 'ok' ? 'text-sm text-success' : 'text-sm text-danger'}>
            {test.text}
          </span>
        )}
        <span className="flex-1" />
        {!isNew && <DeleteButton name={draft.name || draft.id} onDelete={() => void run(() => window.hub.config.deleteConnection(connection.id)).then((ok) => ok && onClose())} />}
        <Button onClick={onClose}>{t(dirty ? 'common.cancel' : 'settingsConnections.close')}</Button>
        <Button variant="primary" disabled={!(dirty || isNew) || Boolean(snap.loadError)} onClick={() => void saveNow()} data-testid="connection-save">
          {t('settingsConnections.save')}
        </Button>
      </div>
    </div>
  )
}
