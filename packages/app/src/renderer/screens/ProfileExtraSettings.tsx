import { Plus, Trash2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { ENV_NAME, type FolderOptions, type Profile } from '@workhub/core'
import { Button, Input, Switch } from '../components/atoms'
import { Field, HelpTip, SwitchRow } from '../components/molecules'
import { useI18n } from '../i18n/I18nProvider'
import { cn } from '../lib/cn'
import { PROFILE_SYMBOLS, PROFILE_SYMBOL_IDS } from '../lib/profileSymbols'

// --- Environment variables ---------------------------------------------------------------------

export interface EnvRow {
  name: string
  /** What was typed; empty with `stored` means "keep the stored value". */
  value: string
  /** The secret store holds a value for this name. */
  stored: boolean
}

export interface EnvDraft {
  rows: EnvRow[]
  setRows: (rows: EnvRow[]) => void
  /** The names to save in the profile: valid ones that have a value, typed or stored. */
  names: () => string[]
  /** Writes the typed values and forgets the removed names; true when it went through. */
  commit: (profileId: string) => Promise<boolean>
}

/** The rows of a saved variable name that has a value to keep or one typed now. */
export function envNamesToSave(rows: readonly EnvRow[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const r of rows) {
    const name = r.name.trim()
    if (!ENV_NAME.test(name) || seen.has(name) || (r.value === '' && !r.stored)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}

/** What `profileEnv.save` gets: typed values by name, and the names that left the profile. */
export function envChanges(rows: readonly EnvRow[], savedNames: readonly string[]): { values: Record<string, string>; removed: string[] } {
  const keep = new Set(envNamesToSave(rows))
  const values: Record<string, string> = {}
  const seen = new Set<string>()
  for (const r of rows) {
    const name = r.name.trim()
    // The first row of a name wins, as in `envNamesToSave`.
    if (seen.has(name)) continue
    seen.add(name)
    if (keep.has(name) && r.value !== '') values[name] = r.value
  }
  return { values, removed: savedNames.filter((n) => !keep.has(n)) }
}

/** Draft of the profile's environment variables; reloads when another profile is selected. */
export function useProfileEnvDraft(saved: Profile | undefined): EnvDraft {
  const [rows, setRows] = useState<EnvRow[]>([])
  const savedNames = useRef<string[]>([])
  const id = saved?.id
  useEffect(() => {
    const names = saved?.envNames ?? []
    savedNames.current = names
    setRows(names.map((name) => ({ name, value: '', stored: true })))
    if (!id) return
    let cancelled = false
    void window.hub.profileEnv.stored(id).then((stored) => {
      if (!cancelled) setRows(names.map((name) => ({ name, value: '', stored: stored.includes(name) })))
    })
    return () => {
      cancelled = true
    }
    // The saved names only matter when the selection changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])
  return {
    rows,
    setRows,
    names: () => envNamesToSave(rows),
    commit: async (profileId) => {
      const { values, removed } = envChanges(rows, savedNames.current)
      if (Object.keys(values).length === 0 && removed.length === 0) return true
      try {
        await window.hub.profileEnv.save(profileId, values, removed)
      } catch {
        return false
      }
      savedNames.current = envNamesToSave(rows)
      setRows(rows.filter((r) => savedNames.current.includes(r.name.trim())).map((r) => ({ name: r.name.trim(), value: '', stored: true })))
      return true
    }
  }
}

function EnvFields({ env }: { env: EnvDraft }) {
  const { t } = useI18n()
  const update = (index: number, patch: Partial<EnvRow>) => env.setRows(env.rows.map((r, i) => (i === index ? { ...r, ...patch } : r)))
  return (
    <div className="flex flex-col gap-2 py-2">
      {env.rows.map((row, i) => {
        const bad = row.name.trim() !== '' && !ENV_NAME.test(row.name.trim())
        return (
          <div key={i} className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <Input
                aria-label={t('profileExtra.envName')}
                value={row.name}
                spellCheck={false}
                placeholder="NAME"
                className="w-48 font-mono"
                onChange={(e) => update(i, { name: e.target.value })}
              />
              <Input
                aria-label={t('profileExtra.envValue')}
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={row.value}
                placeholder={row.stored ? '••••••••' : t('profileExtra.envValue')}
                title={row.stored ? t('profileExtra.envStored') : undefined}
                className="min-w-0 flex-1"
                onChange={(e) => update(i, { value: e.target.value })}
              />
              <Button size="sm" variant="ghost" aria-label={t('profileExtra.envRemove', { name: row.name || '…' })} icon={<Trash2 className="size-3.5" aria-hidden />} onClick={() => env.setRows(env.rows.filter((_, j) => j !== i))} />
            </div>
            {bad && <p className="text-xs text-danger">{t('profileExtra.envBadName')}</p>}
          </div>
        )
      })}
      <div>
        <Button size="sm" icon={<Plus className="size-3.5" aria-hidden />} onClick={() => env.setRows([...env.rows, { name: '', value: '', stored: false }])}>
          {t('profileExtra.envAdd')}
        </Button>
      </div>
    </div>
  )
}

/** Same look as the group boxes of the profile form in Settings. */
function FieldGroup({ legend, help, children }: { legend: string; help?: ReactNode; children: ReactNode }) {
  return (
    <fieldset className="rounded-md border border-border px-3 pt-1 pb-2">
      <legend className="flex items-center gap-1.5 px-1 text-sm font-medium text-muted">
        {legend}
        {help && <HelpTip text={help} label={legend} />}
      </legend>
      {children}
    </fieldset>
  )
}

// --- The fields -------------------------------------------------------------------------------

/** `folders` as the form edits them (one per line, blanks and spaces dropped). */
const cleanFolders = (folders: string[] | undefined): string[] => (folders ?? []).map((f) => f.trim()).filter(Boolean)

/**
 * Drops the options of folders the profile no longer lists, and the switches never set. A switch
 * turned off stays saved as off: unset means the default behaviour (see `projectChildren`), and a
 * value the user set is never filled from Workhub 1 again.
 */
export function prunedFolderOptions(options: Profile['folderOptions'], folders: string[] | undefined): Profile['folderOptions'] {
  const keep = new Set(cleanFolders(folders))
  const out: Record<string, FolderOptions> = {}
  for (const [folder, o] of Object.entries(options ?? {})) {
    if (!keep.has(folder)) continue
    const set: FolderOptions = {
      ...(typeof o.onlyGitRepos === 'boolean' ? { onlyGitRepos: o.onlyGitRepos } : {}),
      ...(typeof o.subfoldersAreProjects === 'boolean' ? { subfoldersAreProjects: o.subfoldersAreProjects } : {})
    }
    if (Object.keys(set).length) out[folder] = set
  }
  return Object.keys(out).length ? out : undefined
}

/** Profile fields of Workhub 1's profile settings: symbol, folder switches, link browser, "owns outside" and variables. */
export function ProfileExtraFields({ form, onChange, env }: { form: Profile; onChange: (profile: Profile) => void; env: EnvDraft }) {
  const { t } = useI18n()
  const folders = cleanFolders(form.folders)
  const setFolder = (folder: string, patch: FolderOptions) => onChange({ ...form, folderOptions: { ...form.folderOptions, [folder]: { ...form.folderOptions?.[folder], ...patch } } })
  return (
    <>
      <FieldGroup legend={t('profileExtra.symbol')} help={t('profileExtra.symbolHelp')}>
        <div className="flex flex-wrap gap-1.5 py-2" role="radiogroup" aria-label={t('profileExtra.symbol')}>
          <button
            type="button"
            role="radio"
            aria-checked={!form.symbol}
            onClick={() => onChange({ ...form, symbol: undefined })}
            className={cn('h-8 rounded-md border px-2.5 text-sm', !form.symbol ? 'border-accent bg-accent-soft' : 'border-border hover:bg-surface-hover')}
          >
            {t('profileExtra.symbolNone')}
          </button>
          {PROFILE_SYMBOL_IDS.map((id) => {
            const Icon = PROFILE_SYMBOLS[id]!
            return (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={form.symbol === id}
                aria-label={id}
                onClick={() => onChange({ ...form, symbol: id })}
                className={cn('flex size-8 items-center justify-center rounded-md border', form.symbol === id ? 'border-accent bg-accent-soft' : 'border-border hover:bg-surface-hover')}
              >
                <Icon className="size-4" aria-hidden />
              </button>
            )
          })}
        </div>
      </FieldGroup>
      <FieldGroup legend={t('profileExtra.folderFlags')} help={t('profileExtra.folderFlagsHelp')}>
        {folders.length === 0 && <p className="py-2 text-sm text-subtle">{t('profileExtra.folderFlagsEmpty')}</p>}
        {folders.map((folder) => (
          <div key={folder} className="py-1">
            <p className="truncate pt-1 font-mono text-sm text-muted" title={folder}>
              {folder}
            </p>
            <SwitchRow label={t('profileExtra.onlyGitRepos')}>
              <Switch checked={form.folderOptions?.[folder]?.onlyGitRepos === true} onChange={(on) => setFolder(folder, { onlyGitRepos: on })} />
            </SwitchRow>
            <SwitchRow label={t('profileExtra.subfolders')} hint={t('profileExtra.subfoldersHint')}>
              <Switch checked={form.folderOptions?.[folder]?.subfoldersAreProjects === true} onChange={(on) => setFolder(folder, { subfoldersAreProjects: on })} />
            </SwitchRow>
          </div>
        ))}
      </FieldGroup>
      <FieldGroup legend={t('profileExtra.links')}>
        <div className="flex flex-col gap-3 py-2">
          <Field label={t('profileExtra.linkBrowser')} hint={`${t('profileExtra.linkBrowserHint')} ${window.hub.platform === 'mac' ? t('profileExtra.linkBrowserMac') : t('profileExtra.linkBrowserOther')}`}>
            <Input value={form.linkBrowser ?? ''} spellCheck={false} placeholder={window.hub.platform === 'mac' ? 'Google Chrome' : 'chromium'} onChange={(e) => onChange({ ...form, linkBrowser: e.target.value || undefined })} />
          </Field>
          <SwitchRow label={t('profileExtra.ownsOutside')} hint={t('profileExtra.ownsOutsideHint')}>
            <Switch checked={form.ownsOutside === true} onChange={(on) => onChange({ ...form, ownsOutside: on })} />
          </SwitchRow>
        </div>
      </FieldGroup>
      <FieldGroup legend={t('profileExtra.env')} help={t('profileExtra.envHelp')}>
        <EnvFields env={env} />
      </FieldGroup>
    </>
  )
}
