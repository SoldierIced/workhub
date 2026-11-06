import { FolderPlus, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import {
  automaticProfileColor,
  NO_MODULES,
  PROFILE_CONNECTION_KINDS,
  slugId,
  type ConnectionKind,
  type OfferedModule,
  type Profile
} from '@workhub/core'
import { Badge, Button, IconButton, Input, Select, Switch } from '../../components/atoms'
import { Card, CardBody, CardHeader, Field, HelpTip, SwitchRow, useToast } from '../../components/molecules'
import { DeleteButton, useUnsavedForm } from '../../components/organisms/UnsavedChanges'
import { useI18n } from '../../i18n/I18nProvider'
import type { MessageKey } from '../../i18n/translate'
import { profileFieldErrors } from '../../lib/configIssues'
import { addProfileFolder, removeProfileFolder } from '../../lib/profileFolders'
import { abbreviateFolder } from '../../lib/sessionHeader'
import { isDirty, type SaveOutcome } from '../../lib/unsavedChanges'
import { ProfileColorField } from '../ProfileColorField'
import { DefaultFolderField, ProfileExtraFields, prunedFolderOptions, useProfileEnvDraft } from '../ProfileExtraSettings'
import { SlackArchiveField } from '../SlackSettings'
import type { SettingsSectionId } from './sections'
import { FieldGroup, KIND_LABEL, MODULE_LABEL, NoProfileYet, saveProfilePatch, type SectionProps } from './shared'

const emptyProfile = (): Profile => ({ id: '', name: '', connections: {}, accountIds: [], modules: { ...NO_MODULES } })

/** The profile fields Profile and folders edits; the other sections own the rest of the profile. */
const OWN_FIELDS = [
  'name',
  'color',
  'symbol',
  'folders',
  'defaultFolder',
  'folderOptions',
  'worktrees',
  'linkBrowser',
  'linkChromeProfile',
  'linkCommand',
  'ownsOutside',
  'envNames',
  'slackArchiveMinutes'
] as const satisfies readonly (keyof Profile)[]

/** `next` with the fields this form owns taken from `own` (removed when `own` has none). */
function withOwnFields(next: Profile, own: Profile): Profile {
  const out: Record<string, unknown> = { ...next }
  for (const key of OWN_FIELDS) {
    if (own[key] === undefined) delete out[key]
    else out[key] = own[key]
  }
  return out as unknown as Profile
}

/**
 * Settings → Profile and folders: one profile's name, color, folders, folder switches, worktrees,
 * links, environment and Slack archive time. `profileId` null is a new profile.
 */
export function ProfileSection({ snap, run, profileId, onCreated, onDeleted }: SectionProps & { profileId: string | null; onCreated: (id: string) => void; onDeleted: () => void }) {
  const { t } = useI18n()
  const toast = useToast()
  const saved = profileId ? snap.config.profiles.find((x) => x.id === profileId) : undefined
  const [form, setForm] = useState<Profile>(() => (saved ? structuredClone(saved) : emptyProfile()))
  // A new profile's id follows its name until the user edits the id themselves.
  const [idEdited, setIdEdited] = useState(false)
  // Field problems, shown only after a save attempt.
  const [errors, setErrors] = useState<ReturnType<typeof profileFieldErrors> | null>(null)
  const env = useProfileEnvDraft(saved)
  // What the form held when it was loaded or last saved: the save bar shows while it differs.
  const [baseline, setBaseline] = useState<Profile>(form)
  const isNew = saved === undefined

  const save = async (): Promise<SaveOutcome> => {
    // Nothing is sent until the profile is valid: the id and name are the only required fields.
    const found = profileFieldErrors(form, isNew ? snap.config.profiles.map((p) => p.id) : [])
    setErrors(found)
    const problem = found.id ?? found.name
    if (problem) return { ok: false, problem: t(problem) }
    const folders = form.folders?.map((f) => f.trim()).filter(Boolean)
    const profile: Profile = { ...form, folders: folders?.length ? folders : undefined }
    if (!profile.folders) delete profile.folders
    if (!profile.symbol) delete profile.symbol
    if (!profile.defaultFolder?.trim()) delete profile.defaultFolder
    if (!profile.linkBrowser?.trim()) delete profile.linkBrowser
    else profile.linkBrowser = profile.linkBrowser.trim()
    if (!profile.linkChromeProfile?.trim()) delete profile.linkChromeProfile
    if (!profile.linkCommand?.trim()) delete profile.linkCommand
    else profile.linkCommand = profile.linkCommand.trim()
    // Off stays saved as off: a switch the user set is never filled from Workhub 1 again.
    if (profile.ownsOutside === undefined) delete profile.ownsOutside
    const folderOptions = prunedFolderOptions(profile.folderOptions, profile.folders)
    if (folderOptions) profile.folderOptions = folderOptions
    else delete profile.folderOptions
    const envNames = env.names()
    if (envNames.length) profile.envNames = envNames
    else delete profile.envNames
    // Only one profile owns everything outside the folders: taking it lets the others go.
    if (profile.ownsOutside) {
      for (const other of snap.config.profiles.filter((p) => p.id !== profile.id && p.ownsOutside)) {
        if (!(await run(() => window.hub.config.saveProfile({ ...other, ownsOutside: false })))) return { ok: false }
      }
    }
    const ok = isNew ? await run(() => window.hub.config.saveProfile(profile)) : await saveProfilePatch(run, profile.id, (latest) => withOwnFields(latest, profile))
    if (!ok) return { ok: false }
    setBaseline(form)
    if (!(await env.commit(profile.id))) {
      toast(t('profileExtra.envSaved'), 'danger')
      return { ok: false, problem: t('profileExtra.envSaved') }
    }
    if (isNew) onCreated(profile.id)
    return { ok: true }
  }
  useUnsavedForm({ dirty: isDirty(baseline, form) || env.dirty, draft: { form, rows: env.rows }, save, discard: () => {
    setForm(baseline)
    setErrors(null)
    env.reset()
  } })
  const name = form.name || form.id
  const active = !isNew && snap.config.activeProfileId === saved.id

  return (
    <Card>
      <CardHeader
        title={isNew ? t('settings.newProfile') : name}
        as="h2"
        actions={
          !isNew && (
            <>
              {active ? (
                <Badge tone="accent">{t('settings.active')}</Badge>
              ) : (
                <Button size="sm" onClick={() => void run(() => window.hub.config.setActiveProfile(saved.id))} data-testid="profile-make-active">
                  {t('settings.makeActive')}
                </Button>
              )}
              <DeleteButton name={name} onDelete={() => void run(() => window.hub.config.deleteProfile(saved.id)).then((ok) => ok && onDeleted())} />
            </>
          )
        }
      />
      <CardBody className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-4">
          <Field label={t('settings.id')} help={t('help.id')} error={errors?.id && t(errors.id)}>
            <Input
              value={form.id}
              disabled={!isNew}
              onChange={(e) => {
                setIdEdited(true)
                setForm({ ...form, id: e.target.value })
                setErrors(null)
              }}
              placeholder="acme"
            />
          </Field>
          <Field label={t('settings.name')} error={errors?.name && t(errors.name)}>
            <Input
              value={form.name}
              onChange={(e) => {
                const value = e.target.value
                setForm({ ...form, name: value, ...(isNew && !idEdited ? { id: value.trim() ? slugId(value, '') : '' } : {}) })
                setErrors(null)
              }}
              placeholder="Acme"
            />
          </Field>
        </div>
        <ProfileColorField
          value={form.color}
          automatic={automaticProfileColor(isNew ? snap.config.profiles.length : snap.config.profiles.findIndex((p) => p.id === saved.id))}
          onChange={(color) => setForm(({ color: _old, ...rest }) => (color ? { ...rest, color } : rest))}
        />
        <FoldersField folders={form.folders} onChange={(folders) => setForm(({ folders: _old, ...rest }) => (folders ? { ...rest, folders } : rest))} />
        <DefaultFolderField form={form} onChange={(folder) => setForm(({ defaultFolder: _old, ...rest }) => (folder ? { ...rest, defaultFolder: folder } : rest))} />
        <ProfileExtraFields form={form} onChange={setForm} env={env} />
        <FieldGroup legend={t('nav.slack')} help={t('help.profile.slack')}>
          <SlackArchiveField value={form.slackArchiveMinutes} onChange={(minutes) => setForm({ ...form, slackArchiveMinutes: minutes })} />
        </FieldGroup>
      </CardBody>
    </Card>
  )
}

/**
 * The profile's folders as a list: each one short with its full path under it, a button to
 * remove it, and "Add folder…" opening the system folder picker (again for every folder). They are
 * folders on this computer, where the sessions run, so there is no typed path.
 */
function FoldersField({ folders, onChange }: { folders: string[] | undefined; onChange: (folders: string[] | undefined) => void }) {
  const { t } = useI18n()
  const list = folders ?? []
  const add = async () => {
    const picked = await window.hub.pickFolder()
    if (picked) onChange(addProfileFolder(folders, picked))
  }
  return (
    <div className="flex flex-col gap-1.5" data-settings-row data-testid="profile-folders">
      <span className="flex items-center gap-1.5">
        <span className="text-sm font-medium text-muted">{t('settings.folders')}</span>
        <HelpTip text={t('help.profile.folders')} label={t('settings.folders')} />
      </span>
      {list.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-2 text-sm text-subtle">{t('settings.foldersEmpty')}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
          {list.map((folder) => (
            <li key={folder} className="flex items-center gap-2 px-3 py-1.5" data-testid="profile-folder">
              <span className="min-w-0 flex-1" title={folder}>
                <span className="block truncate text-base text-text">{abbreviateFolder(folder)}</span>
                <span className="block truncate font-mono text-xs text-subtle">{folder}</span>
              </span>
              <IconButton size="sm" label={t('settings.folderRemove', { folder })} icon={<X className="size-3.5" aria-hidden />} onClick={() => onChange(removeProfileFolder(folders, folder))} />
            </li>
          ))}
        </ul>
      )}
      <div>
        <Button size="sm" icon={<FolderPlus className="size-3.5" aria-hidden />} onClick={() => void add()} data-testid="profile-folder-add">
          {t('settings.folderAdd')}
        </Button>
      </div>
      <p className="text-xs text-subtle">{t('settings.foldersHint')}</p>
    </div>
  )
}

/** A screen row of Modules and screens: the module (or an always-on screen) and the connection it reads. */
interface ScreenRow {
  key: string
  label: MessageKey
  hint: MessageKey
  module?: OfferedModule
  /** The connection kind the screen reads from, when it has one. */
  kind?: ConnectionKind
  /** The section that sets the screen up. */
  section?: SettingsSectionId
}

const SCREEN_ROWS: readonly ScreenRow[] = [
  { key: 'pullRequests', label: 'nav.pullRequests', hint: 'settings.modules.pullRequestsHint', kind: 'codeHost', section: 'connections' },
  { key: 'tickets', label: 'nav.tickets', hint: 'settings.modules.ticketsHint', kind: 'tracker', section: 'tickets' },
  { key: 'chatWatcher', label: MODULE_LABEL.chatWatcher, hint: 'settings.modules.chatWatcherHint', module: 'chatWatcher', kind: 'chat', section: 'slack' },
  { key: 'automations', label: MODULE_LABEL.automations, hint: 'settings.modules.automationsHint', module: 'automations' },
  { key: 'flowMaps', label: MODULE_LABEL.flowMaps, hint: 'flowMaps.settings.moduleHint', module: 'flowMaps', kind: 'health', section: 'flowMaps' },
  { key: 'health', label: MODULE_LABEL.health, hint: 'health.settings.moduleHint', module: 'health', kind: 'health', section: 'health' },
  { key: 'planner', label: MODULE_LABEL.planner, hint: 'plan.settings.moduleHint', module: 'planner', kind: 'calendar', section: 'plan' }
]

type Picks = Pick<Profile, 'modules' | 'connections' | 'accountIds' | 'agentIds'>
const picksOf = (p: Profile): Picks => ({ modules: { ...p.modules }, connections: { ...p.connections }, accountIds: [...p.accountIds], ...(p.agentIds ? { agentIds: [...p.agentIds] } : {}) })

/**
 * Settings → Modules and screens: which optional screens a profile has, the connection each one
 * reads (with a link to its setup), and the profile's connection, account and agent picks.
 */
export function ModulesSection({ snap, run, profileId, onOpen }: SectionProps & { profileId: string | null; onOpen: (section: SettingsSectionId) => void }) {
  const { t } = useI18n()
  const profile = snap.config.profiles.find((p) => p.id === profileId)
  const [form, setForm] = useState<Picks | null>(() => (profile ? picksOf(profile) : null))
  const [baseline, setBaseline] = useState<Picks | null>(form)
  const save = async (): Promise<SaveOutcome> => {
    if (!profile || !form) return { ok: true }
    const next = (p: Profile): Profile => {
      const out: Profile = { ...p, modules: form.modules, connections: form.connections, accountIds: form.accountIds }
      if (form.agentIds) out.agentIds = form.agentIds
      else delete out.agentIds
      return out
    }
    if (!(await saveProfilePatch(run, profile.id, next))) return { ok: false }
    setBaseline(form)
    return { ok: true }
  }
  useUnsavedForm({ dirty: form !== null && isDirty(baseline, form), draft: form, save, discard: () => setForm(baseline) })
  if (!profile || !form) return <NoProfileYet />

  const toggle = (list: string[], id: string, on: boolean) => (on ? [...list, id] : list.filter((x) => x !== id))
  const connectionName = (id: string | undefined) => {
    const c = snap.config.connections.find((x) => x.id === id)
    return c ? c.name || c.id : undefined
  }
  const usesOf = (row: ScreenRow): string | undefined => {
    if (row.kind === 'calendar') {
      const names = (profile.planner?.calendarIds ?? []).map(connectionName).filter((n): n is string => Boolean(n))
      return names.length ? names.join(', ') : undefined
    }
    return row.kind ? connectionName(form.connections[row.kind]) : undefined
  }
  const allAgents = form.agentIds === undefined
  const rowLine = (row: ScreenRow): ReactNode => {
    if (!row.kind) return t(row.hint)
    const uses = usesOf(row)
    return (
      <>
        {t(row.hint)}
        <span className="block">{uses ? t('settings.modules.uses', { name: uses }) : t('settings.modules.noConnection')}</span>
      </>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <Card className="px-4" data-testid="settings-modules">
        <h2 className="pt-3 text-md font-semibold">{t('settings.modules.screens')}</h2>
        <div className="divide-y divide-border">
          {SCREEN_ROWS.map((row) => (
            <div key={row.key} className="flex items-center justify-between gap-4 py-2.5" data-settings-row data-testid={`settings-module-${row.key}`}>
              <div className="min-w-0">
                <span className="block text-base text-text">{t(row.label)}</span>
                <p className="text-xs text-subtle">{rowLine(row)}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {row.section && (
                  <Button size="sm" variant="ghost" onClick={() => onOpen(row.section!)}>
                    {t('settings.modules.edit')}
                  </Button>
                )}
                {row.module ? (
                  <Switch
                    aria-label={t(row.label)}
                    checked={form.modules[row.module]}
                    disabled={Boolean(snap.loadError)}
                    onChange={(on) => setForm({ ...form, modules: { ...form.modules, [row.module!]: on } })}
                  />
                ) : (
                  <Badge tone="neutral">{t('settings.modules.alwaysOn')}</Badge>
                )}
              </div>
            </div>
          ))}
        </div>
        {form.modules.flowMaps && !form.modules.health && <p className="pb-3 text-xs text-warning">{t('flowMaps.settings.needsHealth')}</p>}
      </Card>
      <FieldGroup legend={t('settings.connections')} help={t('help.profile.connections')}>
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 py-2">
          {PROFILE_CONNECTION_KINDS.map((kind) => (
            <Field key={kind} label={t(KIND_LABEL[kind])}>
              <Select
                value={form.connections[kind] ?? ''}
                onChange={(v) => {
                  const connections = { ...form.connections }
                  if (v) connections[kind] = v
                  else delete connections[kind]
                  setForm({ ...form, connections })
                }}
                options={[{ value: '', label: t('common.none') }, ...snap.config.connections.filter((c) => c.kind === kind).map((c) => ({ value: c.id, label: c.name || c.id }))]}
              />
            </Field>
          ))}
        </div>
      </FieldGroup>
      <FieldGroup legend={t('settings.accountsList')} help={t('help.profile.accounts')}>
        <p className="pt-1 text-sm text-subtle">{t('settings.accountsOwnSignIn')}</p>
        {snap.config.accounts.length === 0 && <p className="py-2 text-sm text-subtle">{t('settings.noAccounts')}</p>}
        {snap.config.accounts.map((a) => (
          <SwitchRow key={a.id} label={`${a.name} · ${snap.agents.find((x) => x.id === a.agentId)?.name ?? a.agentId}`}>
            <Switch checked={form.accountIds.includes(a.id)} onChange={(on) => setForm({ ...form, accountIds: toggle(form.accountIds, a.id, on) })} />
          </SwitchRow>
        ))}
      </FieldGroup>
      <FieldGroup legend={t('settings.agentsOffered')} help={t('help.profile.agentsOffered')}>
        <SwitchRow label={t('settings.allAgents')}>
          <Switch
            checked={allAgents}
            onChange={(on) => {
              const next = { ...form }
              if (on) delete next.agentIds
              else next.agentIds = []
              setForm(next)
            }}
          />
        </SwitchRow>
        {!allAgents &&
          snap.agents.map((a) => (
            <SwitchRow key={a.id} label={a.name}>
              <Switch checked={form.agentIds?.includes(a.id) ?? false} onChange={(on) => setForm({ ...form, agentIds: toggle(form.agentIds ?? [], a.id, on) })} />
            </SwitchRow>
          ))}
      </FieldGroup>
    </div>
  )
}

