import { FolderPlus, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { automaticProfileColor, NO_MODULES, slugId, type Profile } from '@workhub/core'
import { Badge, Button, IconButton, Input } from '../../components/atoms'
import { Card, CardBody, CardHeader, Field, HelpTip, useToast } from '../../components/molecules'
import { DeleteButton, useUnsavedForm } from '../../components/organisms/UnsavedChanges'
import { useI18n } from '../../i18n/I18nProvider'
import { profileFieldErrors } from '../../lib/configIssues'
import { addProfileFolder, removeProfileFolder } from '../../lib/profileFolders'
import { abbreviateFolder } from '../../lib/sessionHeader'
import { isDirty, type SaveOutcome } from '../../lib/unsavedChanges'
import { ProfileColorField } from '../ProfileColorField'
import { DefaultFolderField, ProfileExtraFields, prunedFolderOptions, useProfileEnvDraft } from '../ProfileExtraSettings'
import type { ProfileTab } from './sections'
import { saveProfilePatch, type SectionProps } from './shared'

const emptyProfile = (): Profile => ({ id: '', name: '', connections: {}, accountIds: [], modules: { ...NO_MODULES } })

/**
 * The profile fields this form edits (header, Folders, Sessions and links); the Screens and Agents
 * tabs own the rest of the profile and save it on their own.
 */
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
  'envNames'
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

/** A new profile's form: empty, or a copy of `source` (its screens, connections and agents; not its id, secrets or "folders without a profile"). */
function newProfileForm(source: Profile | undefined, copyName: (name: string) => string): Profile {
  if (!source) return emptyProfile()
  const copy = structuredClone(source)
  delete copy.ownsOutside
  delete copy.envNames
  return { ...copy, id: '', name: copyName(source.name || source.id) }
}

export interface ProfileEditorProps extends SectionProps {
  /** The profile to edit; null for a new one. */
  profileId: string | null
  /** A new profile starts as a copy of this one. */
  copyOf?: string | null
  tab: ProfileTab
  /** The tab bar, shown between the header and the tab's content. */
  tabBar: ReactNode
  /** The content of the tabs this form does not hold (Screens, Agents). */
  children?: ReactNode
  onCreated: (id: string) => void
  onDeleted: () => void
}

/**
 * Settings → Profiles › a profile: its header (name, colour, symbol, delete) and, on the Folders
 * and Sessions and links tabs, its folders, folder options, worktrees, links, environment and
 * "use this profile for folders without one". One form with one save bar entry, kept while the
 * tabs change.
 */
export function ProfileEditor({ snap, run, profileId, copyOf, tab, tabBar, children, onCreated, onDeleted }: ProfileEditorProps) {
  const { t } = useI18n()
  const toast = useToast()
  const saved = profileId ? snap.config.profiles.find((x) => x.id === profileId) : undefined
  const source = copyOf ? snap.config.profiles.find((x) => x.id === copyOf) : undefined
  const [form, setForm] = useState<Profile>(() => (saved ? structuredClone(saved) : newProfileForm(source, (name) => t('settingsV2.profiles.copyName', { name }))))
  // A new profile's id follows its name until the user edits the id themselves.
  const [idEdited, setIdEdited] = useState(false)
  // Field problems, shown only after a save attempt.
  const [errors, setErrors] = useState<ReturnType<typeof profileFieldErrors> | null>(null)
  const env = useProfileEnvDraft(saved)
  // What the form held when it was loaded or last saved: the save bar shows while it differs (a copy is unsaved from the start).
  const [baseline, setBaseline] = useState<Profile>(() => (source && !saved ? emptyProfile() : form))
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
  useUnsavedForm({
    dirty: isDirty(baseline, form) || env.dirty,
    draft: { form, rows: env.rows },
    save,
    discard: () => {
      setForm(baseline)
      setErrors(null)
      env.reset()
    }
  })
  const name = form.name || form.id
  const active = !isNew && snap.config.activeProfileId === saved.id

  return (
    <div className="flex flex-col gap-4" data-testid="profile-editor">
      <Card>
        <CardHeader
          title={isNew ? t('settings.newProfile') : name}
          as="h2"
          actions={
            !isNew && (
              <>
                {active && <Badge tone="accent">{t('settings.active')}</Badge>}
                <DeleteButton name={name} onDelete={() => void run(() => window.hub.config.deleteProfile(saved.id)).then((ok) => ok && onDeleted())} />
              </>
            )
          }
        />
        <CardBody className="flex flex-col gap-4">
          <p className="text-sm text-subtle" data-testid="profile-editing-note">
            {t('settingsV2.profiles.editingNote')}
          </p>
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
          <ProfileExtraFields form={form} onChange={setForm} env={env} parts={['symbol']} />
        </CardBody>
      </Card>
      {tabBar}
      {tab === 'folders' && (
        <Card className="px-4 py-3" data-testid="profile-tab-folders">
          <div className="flex flex-col gap-4">
            <FoldersField folders={form.folders} onChange={(folders) => setForm(({ folders: _old, ...rest }) => (folders ? { ...rest, folders } : rest))} />
            <DefaultFolderField form={form} onChange={(folder) => setForm(({ defaultFolder: _old, ...rest }) => (folder ? { ...rest, defaultFolder: folder } : rest))} />
            <ProfileExtraFields form={form} onChange={setForm} env={env} parts={['folderFlags', 'worktrees']} />
          </div>
        </Card>
      )}
      {tab === 'sessions' && (
        <Card className="px-4 py-3" data-testid="profile-tab-sessions">
          <div className="flex flex-col gap-4">
            <ProfileExtraFields form={form} onChange={setForm} env={env} parts={['links', 'env']} />
          </div>
        </Card>
      )}
      {children}
    </div>
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
