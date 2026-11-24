import { RotateCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { hostIdOf, type ProfileHost } from '@workhub/core'
import { Button, Select, Spinner } from '../../components/atoms'
import { Field } from '../../components/molecules'
import { useI18n } from '../../i18n/I18nProvider'
import { formatBytes } from '../../lib/localReview'
import { hostChoices, hostOfOptionValue, hostOptionValue } from '../../lib/profileHost'
import type { HostStatus, WslDistrosResult } from '../../../shared/hosts-api'

export interface ProfileHostPickerProps {
  /** The host the form holds (undefined: this computer). */
  value: ProfileHost | undefined
  /** The host the saved profile names: the status line is only about a saved choice. */
  savedHost: ProfileHost | undefined
  /** Null while the list is loading. */
  distros: WslDistrosResult | null
  statuses: HostStatus[]
  onChange: (host: ProfileHost | undefined) => void
  onRetry: (id: string) => void
}

/** "Where sessions run": this computer or a WSL distribution, with the chosen host's status under it. */
export function ProfileHostPicker({ value, savedHost, distros, statuses, onChange, onRetry }: ProfileHostPickerProps) {
  const { t } = useI18n()
  const options = hostChoices(distros?.distros ?? [], value).map((c) => ({
    value: c.value,
    label: c.distro === null ? t('profileHost.local') : t(c.missing ? 'profileHost.wslMissing' : c.isDefault ? 'profileHost.wslDefault' : 'profileHost.wsl', { distro: c.distro })
  }))
  return (
    <div className="flex flex-col gap-1.5" data-settings-row data-testid="profile-host">
      <Field label={t('profileHost.label')} hint={t('profileHost.hint')}>
        <Select aria-label={t('profileHost.label')} value={hostOptionValue(value)} onChange={(v) => onChange(hostOfOptionValue(v))} options={options} />
      </Field>
      {distros?.reason === 'none' && <p className="text-xs text-subtle">{t('profileHost.noDistros')}</p>}
      {value?.kind === 'wsl' && <HostStatusLine host={value} saved={savedHost !== undefined && hostIdOf(savedHost) === hostIdOf(value)} statuses={statuses} onRetry={onRetry} />}
    </div>
  )
}

function HostStatusLine({ host, saved, statuses, onRetry }: { host: Extract<ProfileHost, { kind: 'wsl' }>; saved: boolean; statuses: HostStatus[]; onRetry: (id: string) => void }) {
  const { t, locale } = useI18n()
  const { distro } = host
  const id = hostIdOf(host)
  const status = statuses.find((s) => s.id === id)
  const line = (text: string, tone = 'text-subtle', busy = false) => (
    <p role="status" aria-live="polite" className={`flex items-center gap-1.5 text-xs ${tone}`} data-testid="profile-host-status">
      {busy && <Spinner className="size-3" />}
      <span>{text}</span>
    </p>
  )
  if (!saved || !status) return line(t('profileHost.pending'))
  switch (status.state) {
    case 'connecting':
      return line(t('profileHost.connecting', { distro }), 'text-subtle', true)
    case 'installing': {
      const p = status.installProgress
      if (p?.phase === 'downloading') {
        const received = formatBytes(p.received ?? 0, locale)
        const text = p.total ? t('profileHost.downloading', { distro, received, total: formatBytes(p.total, locale) }) : t('profileHost.downloadingUnknown', { distro, received })
        return line(text, 'text-subtle', true)
      }
      return line(t(p?.phase === 'verifying' ? 'profileHost.verifying' : 'profileHost.unpacking', { distro }), 'text-subtle', true)
    }
    case 'connected':
      return status.warning === 'noControl' ? line(t('profileHost.noControl', { distro }), 'text-warning') : line(t('profileHost.connected', { distro }), 'text-success')
    case 'unavailable':
      return line(t('profileHost.unavailable'))
    case 'failed':
      return (
        <div className="flex items-start gap-2">
          <p role="status" aria-live="polite" className="min-w-0 flex-1 text-xs text-danger" data-testid="profile-host-status">
            {t('profileHost.failed', { distro, detail: status.detail ?? '' })}
          </p>
          <Button size="sm" icon={<RotateCw className="size-3.5" aria-hidden />} aria-label={t('profileHost.retryLabel', { distro })} onClick={() => onRetry(id)} data-testid="profile-host-retry">
            {t('profileHost.retry')}
          </Button>
        </div>
      )
  }
}

/** The picker with its data: the WSL distributions and every host's status, kept up to date. Shown on Windows only. */
export function ProfileHostField(props: Pick<ProfileHostPickerProps, 'value' | 'savedHost' | 'onChange'>) {
  if (window.hub.platform !== 'windows') return null
  return <ProfileHostLoader {...props} />
}

function ProfileHostLoader(props: Pick<ProfileHostPickerProps, 'value' | 'savedHost' | 'onChange'>) {
  const [distros, setDistros] = useState<WslDistrosResult | null>(null)
  const [statuses, setStatuses] = useState<HostStatus[]>([])
  useEffect(() => {
    let live = true
    void window.hub.hosts.wslDistros().then((d) => live && setDistros(d), () => live && setDistros({ distros: [], reason: 'none' }))
    void window.hub.hosts.status().then((s) => live && setStatuses(s), () => undefined)
    const off = window.hub.hosts.onStatus(setStatuses)
    return () => {
      live = false
      off()
    }
  }, [])
  return <ProfileHostPicker {...props} distros={distros} statuses={statuses} onRetry={(id) => void window.hub.hosts.retry(id)} />
}
