import { useEffect, useRef, useState } from 'react'
import { CONNECTION_KINDS, type Connection, type ConnectionKind, type SecretChange } from '@workhub/core'
import { Input, Select, Switch, Textarea } from '../../components/atoms'
import { Field, SwitchRow } from '../../components/molecules'
import { DeleteButton, useUnsavedForm } from '../../components/organisms/UnsavedChanges'
import { useI18n } from '../../i18n/I18nProvider'
import { isDirty, type SaveOutcome } from '../../lib/unsavedChanges'
import { connectionUsers, fromLines, KIND_LABEL, MasterDetail, toLines, type SectionProps } from './shared'

const emptyConnection = (): Connection => ({ id: '', kind: 'codeHost', provider: 'github', settings: {} })

/** Settings → Connections: every service Workhub reads from, each with the profiles that use it. */
export function ConnectionsSection({ snap, run, initialId }: SectionProps & { initialId?: string }) {
  const { t } = useI18n()
  // Opens on the asked-for connection, else the first one: a blank "new" form only when there is none.
  const initial = snap.config.connections.find((x) => x.id === initialId) ?? snap.config.connections[0]
  const [selected, setSelected] = useState<string | null>(initial?.id ?? null)
  const [form, setForm] = useState<Connection>(initial ? { ...initial } : emptyConnection())
  const [settingsText, setSettingsText] = useState(toLines(initial?.settings))
  const secretInput = useRef<HTMLInputElement>(null)
  // Opened from "Enter token": put the cursor in the secret field.
  useEffect(() => {
    if (initialId) secretInput.current?.focus()
  }, [initialId])
  const [secret, setSecret] = useState('')
  const [clearSecret, setClearSecret] = useState(false)
  const [idError, setIdError] = useState(false)
  // What the form held when it was loaded or last saved: the save bar shows while it differs.
  const [baseline, setBaseline] = useState(() => ({ form, settingsText }))

  const select = (id: string | null) => {
    const c = snap.config.connections.find((x) => x.id === id)
    const next = c ? { ...c } : emptyConnection()
    setSelected(c ? c.id : null)
    setForm(next)
    setSettingsText(toLines(c?.settings))
    setBaseline({ form: next, settingsText: toLines(c?.settings) })
    setSecret('')
    setClearSecret(false)
    setIdError(false)
  }

  const providers = snap.providers.filter((p) => p.kind === form.kind)
  const provider = snap.providers.find((p) => p.id === form.provider)
  const hasSecret = selected !== null && snap.connectionsWithSecret.includes(selected)
  const users = selected ? connectionUsers(snap.config, selected) : []

  const save = async (): Promise<SaveOutcome> => {
    if (!form.id.trim()) {
      setIdError(true)
      return { ok: false, problem: t('settings.idRequired') }
    }
    const change: SecretChange = clearSecret ? { action: 'clear' } : secret ? { action: 'set', value: secret } : { action: 'keep' }
    const connection: Connection = { ...form, settings: fromLines(settingsText) }
    if (!connection.endpoint) delete connection.endpoint
    if (!connection.name) delete connection.name
    if (!(await run(() => window.hub.config.saveConnection(connection, change)))) return { ok: false }
    setSelected(connection.id)
    setSecret('')
    setClearSecret(false)
    setBaseline({ form, settingsText })
    return { ok: true }
  }
  useUnsavedForm({
    dirty: isDirty(baseline, { form, settingsText }) || secret !== '' || clearSecret,
    draft: { form, settingsText, secret, clearSecret },
    save,
    discard: () => select(selected)
  })

  return (
    <MasterDetail
      title={t('settings.connections')}
      newLabel={t('common.new')}
      emptyLabel={t('settings.noneYet')}
      items={snap.config.connections}
      selected={selected}
      onSelect={select}
      label={(c) => c.name || c.id}
      meta={(c) => c.provider}
      formTitle={selected ? form.name || form.id : t('settings.newConnection')}
      form={
        <div className="grid grid-cols-2 gap-4">
          {selected && (
            <p className="col-span-2 -mt-1 text-sm text-subtle" data-testid="connection-used-by">
              {users.length ? t('settings.usedBy', { profiles: users.map((p) => p.name || p.id).join(', ') }) : t('settings.usedByNone')}
            </p>
          )}
          <Field label={t('settings.id')} help={t('help.id')} error={idError ? t('settings.idRequired') : undefined}>
            <Input
              value={form.id}
              disabled={selected !== null}
              onChange={(e) => {
                setForm({ ...form, id: e.target.value })
                setIdError(false)
              }}
              placeholder="acme-github"
            />
          </Field>
          <Field label={t('settings.name')}>
            <Input value={form.name ?? ''} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Acme GitHub" />
          </Field>
          <Field label={t('settings.kind')} help={t('help.connection.kind')}>
            <Select
              value={form.kind}
              onChange={(v) => {
                const kind = v as ConnectionKind
                setForm({ ...form, kind, provider: snap.providers.find((p) => p.kind === kind)?.id ?? '' })
              }}
              options={CONNECTION_KINDS.map((k) => ({ value: k, label: t(KIND_LABEL[k]) }))}
            />
          </Field>
          <Field label={t('settings.provider')} help={t('help.connection.provider')}>
            <Select value={form.provider} onChange={(v) => setForm({ ...form, provider: v })} options={providers.map((p) => ({ value: p.id, label: p.name }))} />
          </Field>
          <Field label={provider?.requiresEndpoint ? t('settings.endpointRequired') : t('settings.endpoint')} help={t('help.connection.endpoint')} className="col-span-2">
            <Input value={form.endpoint ?? ''} onChange={(e) => setForm({ ...form, endpoint: e.target.value })} placeholder={provider?.defaultEndpoint ?? 'https://acme.example.com'} spellCheck={false} />
          </Field>
          <Field label={provider?.requiresSecret ? t('settings.secretRequired') : t('settings.secret')} hint={t('settings.secretHint')} help={t('help.connection.secret')} className="col-span-2">
            <Input
              ref={secretInput}
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={hasSecret ? t('settings.secretStored') : t('settings.secretNotSet')}
              autoComplete="off"
            />
          </Field>
          {hasSecret && (
            <div className="col-span-2">
              <SwitchRow label={t('settings.clearSecret')}>
                <Switch checked={clearSecret} onChange={setClearSecret} />
              </SwitchRow>
            </div>
          )}
          <Field label={t('settings.settingsLines')} help={t('help.connection.settings')} className="col-span-2">
            <Textarea rows={3} value={settingsText} onChange={(e) => setSettingsText(e.target.value)} placeholder="scope=org:acme" spellCheck={false} />
          </Field>
        </div>
      }
      headerActions={selected && <DeleteButton name={form.name || form.id} onDelete={() => void run(() => window.hub.config.deleteConnection(selected)).then((ok) => ok && select(null))} />}
    />
  )
}
