import { Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import {
  appOptions,
  HEALTH_FLOOR_CHOICES,
  HEALTH_REFRESH_CHOICES,
  HEALTH_THRESHOLD_RANGES,
  DEFAULT_HEALTH_REFRESH_MINUTES,
  type HealthThresholds,
  type Profile,
  type Result,
  type SecretChange,
  type WorkhubConfig
} from '@workhub/core'
import type { ConfigSnapshot } from '@shared/api'
import { Button, Input, Select, Switch } from '../components/atoms'
import { Card, CardBody, CardHeader, EmptyState, Field, SwitchRow } from '../components/molecules'
import { useI18n } from '../i18n/I18nProvider'
import type { MessageKey } from '../i18n/translate'
import {
  connectionToForm,
  emptyEnvironment,
  environmentId,
  environmentToForm,
  formToConnection,
  formToEnvironment,
  withStockIndices,
  type ConnectionForm,
  type EnvironmentForm
} from '../lib/healthForm'
import { uniqueConnectionId } from '../lib/tickets'

type Run = (op: () => Promise<Result<WorkhubConfig>>) => Promise<boolean>

const THRESHOLD_KEYS = Object.keys(HEALTH_THRESHOLD_RANGES) as (keyof typeof HEALTH_THRESHOLD_RANGES)[]

/** Settings → Health: the Elasticsearch connection of the active profile, its refresh interval and the environments to watch. */
export function HealthSettings({ snap, run, focusSecret }: { snap: ConfigSnapshot; run: Run; focusSecret?: boolean }) {
  const { t } = useI18n()
  const profile = snap.config.profiles.find((p) => p.id === snap.config.activeProfileId)
  const connection = snap.config.connections.find((c) => c.id === profile?.connections.health)
  const [demo, setDemo] = useState(false)
  const [form, setForm] = useState<ConnectionForm>(() => connectionToForm(connection))
  const [refresh, setRefresh] = useState<number>(profile?.health?.refreshMinutes ?? DEFAULT_HEALTH_REFRESH_MINUTES)
  const [envs, setEnvs] = useState<EnvironmentForm[]>(() => (profile?.health?.environments ?? []).map(environmentToForm))
  const [test, setTest] = useState<{ state: 'idle' | 'running' } | { state: 'ok' | 'failed'; text: string }>({ state: 'idle' })
  const [formError, setFormError] = useState<MessageKey | null>(null)

  // The form follows the profile: switching profile (or saving) loads what is stored.
  useEffect(() => {
    setForm(connectionToForm(connection))
    setRefresh(profile?.health?.refreshMinutes ?? DEFAULT_HEALTH_REFRESH_MINUTES)
    setEnvs((profile?.health?.environments ?? []).map(environmentToForm))
    setTest({ state: 'idle' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.id, connection?.id])

  useEffect(() => {
    void window.hub.health.get(profile?.id ?? null).then((v) => setDemo(v.state === 'demo'))
  }, [profile?.id])

  if (!profile) return <EmptyState compact title={t('health.settings.noProfile')} />

  const editable = !snap.loadError
  const stored = form.id !== null && snap.connectionsWithSecret.includes(form.id)
  const setConn = (patch: Partial<ConnectionForm>) => {
    setForm((f) => ({ ...f, ...patch }))
    setTest({ state: 'idle' })
  }
  const secretChange = (): SecretChange => (form.secret ? { action: 'set', value: form.secret } : { action: 'keep' })
  const connectionId = () => form.id ?? uniqueConnectionId('elasticsearch', snap.config.connections.map((c) => c.id))

  const missing = (): MessageKey | null => {
    if (!form.url.trim()) return 'health.settings.missing.url'
    if (form.auth === 'basic' && (!form.username.trim() || form.username.includes(':'))) return 'health.settings.missing.user'
    if (!form.secret && !stored) return 'health.settings.missing.secret'
    if (form.tls === 'pinned' && form.fingerprint.replace(/[^0-9a-fA-F]/g, '').length !== 64) return 'health.settings.missing.fingerprint'
    return null
  }

  const runTest = async () => {
    const gap = missing()
    if (gap) return setTest({ state: 'failed', text: t(gap) })
    setTest({ state: 'running' })
    const first = envs[0]
    const r = await window.hub.health.test(formToConnection(form, connectionId()), secretChange(), first?.errors || first?.traces || first?.metrics || undefined)
    setTest(r.ok ? { state: 'ok', text: t('health.settings.testOk', { account: r.account }) } : { state: 'failed', text: t('health.settings.testFailed', { error: r.error }) })
  }

  /** Saves the profile with what changed; the profile is read again because saving the connection may have changed the config. */
  const saveProfile = (patch: (p: Profile) => Profile) => run(() => window.hub.config.saveProfile(patch(profile)))

  const saveConnection = async () => {
    const gap = missing()
    if (gap) return setFormError(gap)
    setFormError(null)
    const c = formToConnection(form, connectionId())
    if (!(await run(() => window.hub.config.saveConnection(c, secretChange())))) return
    await saveProfile((p) => ({ ...p, connections: { ...p.connections, health: c.id } }))
    setForm((f) => ({ ...f, id: c.id, secret: '' }))
  }

  const saveEnvironments = async () => {
    if (envs.some((e) => !e.name.trim())) return setFormError('health.settings.invalidEnvironment')
    setFormError(null)
    await saveProfile((p) => ({ ...p, health: { refreshMinutes: refresh, environments: envs.map(formToEnvironment) } }))
  }

  const updateEnv = (index: number, patch: Partial<EnvironmentForm>) => setEnvs((all) => all.map((e, i) => (i === index ? { ...e, ...patch } : e)))
  const addEnv = () => setEnvs((all) => [...all, emptyEnvironment(all.map((e) => e.id))])
  const setThreshold = (index: number, key: keyof HealthThresholds, value: number | boolean) =>
    setEnvs((all) => all.map((e, i) => (i === index ? { ...e, thresholds: { ...e.thresholds, [key]: value } } : e)))

  return (
    <div className="flex flex-col gap-4">
      <p className="text-base text-muted">{t('health.settings.intro')}</p>
      {demo && <p className="rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">{t('health.settings.demoNote')}</p>}
      {formError && (
        <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
          {t(formError)}
        </p>
      )}

      <Card className="px-4">
        <SwitchRow label={t('health.settings.module')} help={t('help.health.module')} hint={`${t('health.settings.moduleHint')} (${profile.name})`}>
          <Switch
            checked={profile.modules.health}
            disabled={!editable}
            onChange={(on) => void saveProfile((p) => ({ ...p, modules: { ...p.modules, health: on } }))}
          />
        </SwitchRow>
      </Card>

      <Card>
        <CardHeader title={t('health.settings.connection')} help={t('help.health.connection')} />
        <CardBody className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-4">
            <Field label={t('health.settings.url')} hint={t('health.settings.urlHint')} className="col-span-2">
              <Input value={form.url} onChange={(e) => setConn({ url: e.target.value })} placeholder="https://elastic.example.com:9200" spellCheck={false} autoComplete="off" />
            </Field>
            <Field label={t('health.settings.auth')}>
              <Select
                value={form.auth}
                onChange={(v) => setConn({ auth: v === 'basic' ? 'basic' : 'apiKey' })}
                options={[
                  { value: 'apiKey', label: t('health.settings.auth.apiKey') },
                  { value: 'basic', label: t('health.settings.auth.basic') }
                ]}
              />
            </Field>
            {form.auth === 'basic' && (
              <Field label={t('health.settings.username')}>
                <Input value={form.username} onChange={(e) => setConn({ username: e.target.value })} spellCheck={false} autoComplete="off" />
              </Field>
            )}
            <Field label={form.auth === 'basic' ? t('health.settings.secret.basic') : t('health.settings.secret.apiKey')} className={form.auth === 'basic' ? 'col-span-2' : ''}>
              <Input type="password" autoFocus={focusSecret} value={form.secret} onChange={(e) => setConn({ secret: e.target.value })} placeholder={stored ? t('health.settings.secretStored') : ''} autoComplete="off" />
            </Field>
            <Field label={t('health.settings.tls')} help={t('help.health.tls')}>
              <Select
                value={form.tls}
                onChange={(v) => setConn({ tls: v === 'pinned' || v === 'insecure' ? v : 'system' })}
                options={[
                  { value: 'system', label: t('health.settings.tls.system') },
                  { value: 'pinned', label: t('health.settings.tls.pinned') },
                  { value: 'insecure', label: t('health.settings.tls.insecure') }
                ]}
              />
            </Field>
            {form.tls === 'pinned' && (
              <Field label={t('health.settings.fingerprint')} hint={t('health.settings.fingerprintHint')}>
                <Input value={form.fingerprint} onChange={(e) => setConn({ fingerprint: e.target.value })} spellCheck={false} className="font-mono" />
              </Field>
            )}
          </div>
          {form.tls === 'insecure' && <p className="rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">{t('health.settings.insecureWarning')}</p>}
          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
            <Button variant="primary" disabled={!editable} onClick={() => void saveConnection()}>
              {t('health.settings.saveConnection')}
            </Button>
            <Button onClick={() => void runTest()} disabled={test.state === 'running'}>
              {test.state === 'running' ? t('health.settings.testing') : t('health.settings.test')}
            </Button>
            {(test.state === 'ok' || test.state === 'failed') && (
              <span role="status" className={test.state === 'ok' ? 'text-sm text-success' : 'text-sm text-danger'}>
                {test.text}
              </span>
            )}
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title={t('health.settings.environments')}
          help={t('help.health.environments')}
          actions={
            <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" aria-hidden />} onClick={addEnv} disabled={!editable}>
              {t('health.settings.addEnvironment')}
            </Button>
          }
        />
        <CardBody className="flex flex-col gap-4">
          <p className="text-xs text-subtle">{t('health.settings.environmentsNote')}</p>
          <Field label={t('health.settings.refresh')} className="max-w-48">
            <Select
              value={String(refresh)}
              onChange={(v) => setRefresh(Number(v))}
              options={HEALTH_REFRESH_CHOICES.map((m) => ({ value: String(m), label: t('health.settings.refreshMinutes', { count: m }) }))}
            />
          </Field>
          <Field label={t('health.settings.floor')} hint={t('health.settings.floorHint')} className="max-w-96">
            <Select
              value={String(appOptions(snap.config).healthRefreshFloorMinutes)}
              onChange={(v) => void run(() => window.hub.config.saveOptions({ healthRefreshFloorMinutes: Number(v) }))}
              disabled={!editable}
              options={HEALTH_FLOOR_CHOICES.map((m) => ({ value: String(m), label: t('health.settings.refreshMinutes', { count: m }) }))}
            />
          </Field>
          {envs.length === 0 && <EmptyState compact title={t('health.settings.noEnvironments')} />}
          {envs.map((e, i) => (
            <details key={e.id} open={envs.length === 1 || !e.name} className="rounded-md border border-border">
              <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-base font-medium">
                <span className="flex-1">{e.name || t('health.settings.envName')}</span>
                <button
                  type="button"
                  aria-label={t('health.settings.removeEnvironment', { name: e.name || e.id })}
                  className="inline-flex size-6 items-center justify-center rounded-sm text-subtle hover:bg-danger-soft hover:text-danger"
                  onClick={(ev) => {
                    ev.preventDefault()
                    setEnvs((all) => all.filter((_, j) => j !== i))
                  }}
                >
                  <Trash2 className="size-3.5" aria-hidden />
                </button>
              </summary>
              <div className="grid grid-cols-2 gap-4 border-t border-border p-3">
                <Field label={t('health.settings.envName')}>
                  <Input value={e.name} onChange={(ev) => updateEnv(i, { name: ev.target.value, id: e.id.startsWith('environment') ? environmentId(ev.target.value, envs.filter((_, j) => j !== i).map((x) => x.id)) : e.id })} />
                </Field>
                <Field label={t('health.settings.envValues')} hint={t('health.settings.envValuesHint')}>
                  <Input value={e.values} onChange={(ev) => updateEnv(i, { values: ev.target.value })} placeholder="prod, production" spellCheck={false} />
                </Field>
                <Field label={t('health.settings.indexErrors')}>
                  <Input value={e.errors} onChange={(ev) => updateEnv(i, { errors: ev.target.value })} placeholder="logs-apm.error-*" spellCheck={false} className="font-mono" />
                </Field>
                <Field label={t('health.settings.indexTraces')}>
                  <Input value={e.traces} onChange={(ev) => updateEnv(i, { traces: ev.target.value })} placeholder="traces-apm-*" spellCheck={false} className="font-mono" />
                </Field>
                <Field label={t('health.settings.indexMetrics')}>
                  <Input value={e.metrics} onChange={(ev) => updateEnv(i, { metrics: ev.target.value })} placeholder="metrics-apm.internal-*" spellCheck={false} className="font-mono" />
                </Field>
                <div className="flex items-end">
                  <Button size="sm" variant="ghost" onClick={() => setEnvs((all) => all.map((x, j) => (j === i ? withStockIndices(x) : x)))}>
                    {t('health.settings.useStock')}
                  </Button>
                </div>
                <Field label={t('health.settings.k8sSuffix')} hint={t('health.settings.k8sSuffixHint')}>
                  <Input value={e.k8sSuffix} onChange={(ev) => updateEnv(i, { k8sSuffix: ev.target.value })} spellCheck={false} className="font-mono" />
                </Field>
                <Field label={t('health.settings.kibana')} hint={t('health.settings.kibanaHint')}>
                  <Input value={e.kibana} onChange={(ev) => updateEnv(i, { kibana: ev.target.value })} placeholder="https://kibana.example.com" spellCheck={false} />
                </Field>
                <div className="col-span-2">
                  <SwitchRow label={t('health.settings.kubeState')} hint={t('health.settings.kubeStateHint')}>
                    <Switch checked={e.kubeState} onChange={(on) => updateEnv(i, { kubeState: on })} />
                  </SwitchRow>
                </div>
                <details className="col-span-2">
                  <summary className="cursor-pointer text-sm font-medium text-muted">{t('health.settings.thresholds')}</summary>
                  <div className="mt-3 grid grid-cols-2 gap-4">
                    {THRESHOLD_KEYS.map((key) => (
                      <Field key={key} label={t(`health.settings.threshold.${key}` as MessageKey)}>
                        <Input
                          type="number"
                          min={HEALTH_THRESHOLD_RANGES[key][0]}
                          max={HEALTH_THRESHOLD_RANGES[key][1]}
                          value={e.thresholds[key]}
                          onChange={(ev) => setThreshold(i, key, Number(ev.target.value))}
                        />
                      </Field>
                    ))}
                    <div className="col-span-2">
                      <SwitchRow label={t('health.settings.threshold.silentServicesDegrade')}>
                        <Switch checked={e.thresholds.silentServicesDegrade} onChange={(on) => setThreshold(i, 'silentServicesDegrade', on)} />
                      </SwitchRow>
                    </div>
                  </div>
                </details>
              </div>
            </details>
          ))}
          <div className="border-t border-border pt-4">
            <Button variant="primary" disabled={!editable} onClick={() => void saveEnvironments()}>
              {t('health.settings.saveEnvironments')}
            </Button>
          </div>
        </CardBody>
      </Card>
    </div>
  )
}
