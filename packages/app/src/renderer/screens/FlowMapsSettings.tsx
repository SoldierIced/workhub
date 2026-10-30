import { FolderOpen, Trash2, Upload } from 'lucide-react'
import { useEffect, useState } from 'react'
import { moduleScreens, type Profile, type Result, type WorkhubConfig } from '@workhub/core'
import type { ConfigSnapshot } from '@shared/api'
import type { FlowMapSummary } from '@shared/health-api'
import { Button, Switch } from '../components/atoms'
import { Dialog, EmptyState, useToast } from '../components/molecules'
import { useI18n } from '../i18n/I18nProvider'
import { errorText } from '../lib/errorText'
import { SettingRow, SettingsGroup } from './settings/SettingsLayout'

type Run = (op: () => Promise<Result<WorkhubConfig>>) => Promise<boolean>

const ENDPOINT_EXAMPLE = `curl --unix-socket "$WORKHUB_SOCKET" -X POST http://workhub/v1/flow-maps \\
  -H 'content-type: application/json' --data-binary @my-flow.json`

/** Settings → Flow maps: the screen's switch for the active profile, the maps folder, importing files and the maps it holds. */
export function FlowMapsSettings({ snap, run }: { snap: ConfigSnapshot; run: Run }) {
  const { t, tn } = useI18n()
  const toast = useToast()
  const profile = snap.config.profiles.find((p) => p.id === snap.config.activeProfileId)
  const [folder, setFolder] = useState('')
  const [maps, setMaps] = useState<FlowMapSummary[] | null>(null)
  const [error, setError] = useState<string>()
  const [deleting, setDeleting] = useState<FlowMapSummary | null>(null)
  const [busy, setBusy] = useState(false)
  const load = () =>
    window.hub.health
      .flowMaps(profile?.id ?? null)
      .then((m) => {
        setMaps(m)
        setError(undefined)
      })
      .catch((e: unknown) => setError(errorText(e)))
  useEffect(() => {
    void window.hub.flowMaps.folder().then(setFolder, () => setFolder(''))
    void load()
  }, [profile?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!profile) return <EmptyState compact title={t('flowMaps.settings.noProfile')} />
  const modules = moduleScreens(profile.modules)
  const on = modules.includes('flowMaps')
  const healthOn = modules.includes('health')
  const saveProfile = (patch: (p: Profile) => Profile) => run(() => window.hub.config.saveProfile(patch(profile)))
  const envName = (id: string) => profile.health?.environments.find((e) => e.id === id)?.name ?? id

  const importFiles = async () => {
    setBusy(true)
    try {
      const results = await window.hub.flowMaps.importFiles()
      const good = results.filter((r) => r.ok).length
      if (good) toast(tn('flowMaps.settings.imported', good))
      for (const r of results) if (!r.ok) toast(t('flowMaps.settings.importFailed', { file: r.file.split(/[\\/]/).pop() ?? r.file, errors: r.errors.slice(0, 3).join('; ') }), 'danger')
      await load()
    } catch (e) {
      toast(errorText(e), 'danger')
    } finally {
      setBusy(false)
    }
  }
  const remove = async () => {
    if (!deleting) return
    const ok = await window.hub.flowMaps.remove(deleting.id)
    toast(ok ? t('flowMaps.settings.deleted') : t('flowMaps.settings.deleteFailed'), ok ? undefined : 'danger')
    setDeleting(null)
    await load()
  }

  return (
    <div className="flex flex-col gap-6" data-testid="flow-maps-settings">
      <SettingsGroup title={t('flowMaps.settings.tab')} footnote={!healthOn ? t('flowMaps.settings.needsHealth') : undefined}>
        <SettingRow label={t('flowMaps.settings.module')} hint={t('flowMaps.settings.moduleHint')}>
          <div className="flex justify-end">
            <Switch checked={on} disabled={Boolean(snap.loadError)} onChange={(next) => void saveProfile((p) => ({ ...p, modules: { ...p.modules, flowMaps: next } }))} aria-label={t('flowMaps.settings.module')} />
          </div>
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title={t('flowMaps.settings.folder')} footnote={t('flowMaps.settings.format')}>
        <div className="flex flex-col gap-2 py-3">
          <code className="break-all rounded bg-surface-raised px-2 py-1 text-xs text-muted" data-testid="flow-maps-folder">{folder || '…'}</code>
          <p className="text-xs text-subtle">{t('flowMaps.settings.folderHint')}</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" icon={<FolderOpen className="size-3.5" aria-hidden />} onClick={() => window.hub.flowMaps.reveal()}>
              {t('flowMaps.settings.reveal')}
            </Button>
            <Button size="sm" variant="primary" icon={<Upload className="size-3.5" aria-hidden />} disabled={busy} onClick={() => void importFiles()}>
              {t('flowMaps.settings.import')}
            </Button>
          </div>
        </div>
        <div className="flex flex-col gap-1 py-3">
          <p className="text-xs text-subtle">{t('flowMaps.settings.endpoint')}</p>
          <pre className="overflow-x-auto rounded bg-surface-raised px-2 py-1.5 text-[11px] text-muted">{ENDPOINT_EXAMPLE}</pre>
        </div>
      </SettingsGroup>

      <SettingsGroup title={t('flowMaps.settings.list')}>
        {error && <p className="py-3 text-sm text-danger">{error}</p>}
        {maps && maps.length === 0 && <p className="py-3 text-sm text-muted">{t('flowMaps.settings.empty')}</p>}
        {(maps ?? []).map((m) => (
          <div key={m.file} className="flex items-center gap-3 py-2.5" data-testid="flow-maps-settings-row">
            <div className="min-w-0 flex-1">
              <p className="truncate text-base">
                {m.name}
                {m.error && <span className="ml-2 text-xs text-danger">{t('flowMaps.invalidShort')}</span>}
              </p>
              <p className="truncate text-xs text-subtle" title={m.error ?? m.file}>
                {m.error ? m.error : `${t('flowMaps.size', { nodes: m.nodes, edges: m.edges })} · ${m.environmentId ? t('flowMaps.settings.env', { env: envName(m.environmentId) }) : t('flowMaps.settings.anyEnv')} · ${m.file.split(/[\\/]/).pop()}`}
              </p>
            </div>
            <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" aria-hidden />} onClick={() => setDeleting(m)}>
              {t('flowMaps.settings.delete')}
            </Button>
          </div>
        ))}
      </SettingsGroup>

      <Dialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={t('flowMaps.settings.deleteTitle')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="danger" onClick={() => void remove()}>
              {t('flowMaps.settings.delete')}
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted">{deleting ? t('flowMaps.settings.deleteBody', { file: deleting.file.split(/[\\/]/).pop() ?? deleting.file }) : ''}</p>
      </Dialog>
    </div>
  )
}
