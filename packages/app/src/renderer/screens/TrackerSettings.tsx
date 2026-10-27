import { Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { Connection, Result, SecretChange, WorkhubConfig } from '@workhub/core'
import type { ConfigSnapshot } from '@shared/api'
import { Badge, Button, Input, Select, Switch } from '../components/atoms'
import { Card, CardBody, CardHeader, EmptyState, Field, ListRow, SwitchRow } from '../components/molecules'
import { useI18n } from '../i18n/I18nProvider'
import type { MessageKey } from '../i18n/translate'
import { uniqueConnectionId } from '../lib/tickets'

/** The settings keys of a tracker connection; the main process reads the same ones. */
const EMAIL = 'email'
const PROJECT_KEYS = 'projectKeys'
const IGNORED = 'ignoredStatuses'

const PROVIDERS = [
  { value: 'jira', label: 'Jira' },
  { value: 'linear', label: 'Linear' }
]

interface Form {
  /** Set once the tracker is saved; the id never changes. */
  id: string | null
  provider: string
  name: string
  site: string
  email: string
  projectKeys: string
  ignored: string
  secret: string
  useInProfile: boolean
}

const emptyForm = (): Form => ({ id: null, provider: 'jira', name: '', site: '', email: '', projectKeys: '', ignored: '', secret: '', useInProfile: true })

function toForm(c: Connection, activeTracker: string | undefined): Form {
  return {
    id: c.id,
    provider: c.provider,
    name: c.name ?? '',
    site: c.endpoint ?? '',
    email: c.settings[EMAIL] ?? '',
    projectKeys: c.settings[PROJECT_KEYS] ?? '',
    ignored: c.settings[IGNORED] ?? '',
    secret: '',
    useInProfile: activeTracker === c.id
  }
}

type Run = (op: () => Promise<Result<WorkhubConfig>>) => Promise<boolean>

/** Settings → Trackers: where the Tickets screen reads from, with a connection test. */
export function TrackerSettings({ snap, run }: { snap: ConfigSnapshot; run: Run }) {
  const { t } = useI18n()
  const trackers = snap.config.connections.filter((c) => c.kind === 'tracker')
  const activeProfile = snap.config.profiles.find((p) => p.id === snap.config.activeProfileId)
  const [demo, setDemo] = useState(false)
  const [form, setForm] = useState<Form>(emptyForm())
  const [test, setTest] = useState<{ state: 'idle' | 'running' } | { state: 'ok' | 'failed'; text: string }>({ state: 'idle' })

  useEffect(() => {
    void window.hub.tickets.status(activeProfile?.id ?? null).then((st) => setDemo(st.state === 'demo'))
  }, [activeProfile?.id])

  const isJira = form.provider === 'jira'
  const stored = form.id !== null && snap.connectionsWithSecret.includes(form.id)
  const set = (patch: Partial<Form>) => {
    setForm((f) => ({ ...f, ...patch }))
    setTest({ state: 'idle' })
  }
  const select = (id: string | null) => {
    const c = trackers.find((x) => x.id === id)
    setForm(c ? toForm(c, activeProfile?.connections.tracker) : emptyForm())
    setTest({ state: 'idle' })
  }

  const connection = (): Connection => {
    const previous = trackers.find((c) => c.id === form.id)
    const settings: Record<string, string> = { ...previous?.settings }
    const put = (key: string, value: string) => (value.trim() ? (settings[key] = value.trim()) : delete settings[key])
    put(EMAIL, isJira ? form.email : '')
    put(PROJECT_KEYS, form.projectKeys)
    put(IGNORED, form.ignored)
    const id = form.id ?? uniqueConnectionId(form.name || form.provider, snap.config.connections.map((c) => c.id))
    return {
      id,
      kind: 'tracker',
      provider: form.provider,
      ...(form.name.trim() ? { name: form.name.trim() } : {}),
      ...(isJira && form.site.trim() ? { endpoint: form.site.trim() } : {}),
      settings
    }
  }
  const secretChange = (): SecretChange => (form.secret ? { action: 'set', value: form.secret } : { action: 'keep' })

  const missing = (): MessageKey | null => {
    if (isJira && !form.site.trim()) return 'trackers.missing.site'
    if (isJira && !form.email.trim()) return 'trackers.missing.email'
    if (!form.secret && !stored) return 'trackers.missing.token'
    return null
  }

  const runTest = async () => {
    const gap = missing()
    if (gap) return setTest({ state: 'failed', text: t(gap) })
    setTest({ state: 'running' })
    const r = await window.hub.tickets.test(connection(), secretChange())
    setTest(r.ok ? { state: 'ok', text: t('trackers.testOk', { account: r.account }) } : { state: 'failed', text: t('trackers.testFailed', { error: r.error }) })
  }

  const save = async () => {
    const c = connection()
    if (!(await run(() => window.hub.config.saveConnection(c, secretChange())))) return
    if (activeProfile && form.useInProfile && activeProfile.connections.tracker !== c.id) {
      await run(() => window.hub.config.saveProfile({ ...activeProfile, connections: { ...activeProfile.connections, tracker: c.id } }))
    } else if (activeProfile && !form.useInProfile && activeProfile.connections.tracker === c.id) {
      const { tracker: _removed, ...rest } = activeProfile.connections
      await run(() => window.hub.config.saveProfile({ ...activeProfile, connections: rest }))
    }
    setForm((f) => ({ ...f, id: c.id, secret: '' }))
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-base text-muted">{t('trackers.intro')}</p>
      {demo && <p className="rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">{t('trackers.demoNote')}</p>}
      <div className="grid grid-cols-[17rem_minmax(0,1fr)] items-start gap-4">
        <Card>
          <CardHeader
            title={t('trackers.list')}
            as="h2"
            actions={
              <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" aria-hidden />} onClick={() => select(null)}>
                {t('common.new')}
              </Button>
            }
          />
          <CardBody className="px-2 pb-2">
            {trackers.length === 0 ? (
              <EmptyState compact title={t('trackers.empty')} />
            ) : (
              <ul className="flex flex-col gap-0.5">
                {trackers.map((c) => (
                  <li key={c.id}>
                    <ListRow
                      title={c.name || c.id}
                      selected={form.id === c.id}
                      trailing={activeProfile?.connections.tracker === c.id ? <Badge tone="accent">{activeProfile.name}</Badge> : c.provider}
                      onClick={() => select(c.id)}
                    />
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title={form.id ? form.name || form.id : t('trackers.new')} as="h2" />
          <CardBody className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-4">
              <Field label={t('trackers.provider')}>
                <Select value={form.provider} onChange={(v) => set({ provider: v })} options={PROVIDERS} disabled={form.id !== null} />
              </Field>
              <Field label={t('trackers.name')}>
                <Input value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder={isJira ? 'Team Jira' : 'Team Linear'} />
              </Field>
              {isJira && (
                <>
                  <Field label={t('trackers.site')} hint={t('trackers.siteHint')}>
                    <Input value={form.site} onChange={(e) => set({ site: e.target.value })} placeholder="your-team.atlassian.net" spellCheck={false} autoComplete="off" />
                  </Field>
                  <Field label={t('trackers.email')}>
                    <Input type="email" value={form.email} onChange={(e) => set({ email: e.target.value })} placeholder="you@example.com" spellCheck={false} autoComplete="off" />
                  </Field>
                </>
              )}
              <Field label={isJira ? t('trackers.token') : t('trackers.apiKey')} hint={isJira ? t('trackers.tokenHintJira') : t('trackers.tokenHintLinear')} className="col-span-2">
                <Input type="password" value={form.secret} onChange={(e) => set({ secret: e.target.value })} placeholder={stored ? t('trackers.tokenStored') : t('trackers.tokenNotSet')} autoComplete="off" />
              </Field>
              <Field label={t('trackers.projectKeys')} hint={t('trackers.projectKeysHint')}>
                <Input value={form.projectKeys} onChange={(e) => set({ projectKeys: e.target.value })} placeholder="ABC, WEB" spellCheck={false} />
              </Field>
              <Field label={t('trackers.ignoredStatuses')} hint={t('trackers.ignoredStatusesHint')}>
                <Input value={form.ignored} onChange={(e) => set({ ignored: e.target.value })} placeholder="Blocked, On hold" />
              </Field>
            </div>
            {activeProfile && (
              <SwitchRow label={t('trackers.useInProfile')} hint={activeProfile.name}>
                <Switch checked={form.useInProfile} onChange={(v) => setForm((f) => ({ ...f, useInProfile: v }))} />
              </SwitchRow>
            )}
            <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
              <Button variant="primary" onClick={() => void save()}>
                {t('trackers.save')}
              </Button>
              <Button onClick={() => void runTest()} disabled={test.state === 'running'}>
                {test.state === 'running' ? t('trackers.testing') : t('trackers.test')}
              </Button>
              {form.id && (
                <Button variant="danger" icon={<Trash2 className="size-3.5" aria-hidden />} onClick={() => void run(() => window.hub.config.deleteConnection(form.id!)).then((ok) => ok && select(null))}>
                  {t('common.delete')}
                </Button>
              )}
              {(test.state === 'ok' || test.state === 'failed') && (
                <span role="status" className={test.state === 'ok' ? 'text-sm text-success' : 'text-sm text-danger'}>
                  {test.text}
                </span>
              )}
            </div>
          </CardBody>
        </Card>
      </div>
    </div>
  )
}
