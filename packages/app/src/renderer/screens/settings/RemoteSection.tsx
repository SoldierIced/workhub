import { Smartphone, Check, X, QrCode, Copy } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import QRCode from 'qrcode'
import { REMOTE_CAPABILITIES, type RemoteCapability, type RemoteDeviceView, type RemoteStatusView } from '../../../shared/remote-api'
import { Badge, Button, Input, Switch } from '../../components/atoms'
import { ConfirmDeleteDialog, Field, SwitchRow } from '../../components/molecules'
import { useI18n } from '../../i18n/I18nProvider'
import type { MessageKey } from '../../i18n/translate'
import { SettingsGroup } from './SettingsLayout'

const CAPABILITY_LABEL: Record<RemoteCapability, MessageKey> = {
  sessions: 'remote.capability.sessions',
  pullRequests: 'remote.capability.pullRequests',
  automations: 'remote.capability.automations',
  health: 'remote.capability.health',
  plan: 'remote.capability.plan'
}
const CAPABILITY_HINT: Record<RemoteCapability, MessageKey> = {
  sessions: 'remote.capability.sessionsHint',
  pullRequests: 'remote.capability.pullRequestsHint',
  automations: 'remote.capability.automationsHint',
  health: 'remote.capability.healthHint',
  plan: 'remote.capability.planHint'
}
const PLATFORM_LABEL: Record<RemoteDeviceView['platform'], MessageKey> = {
  ios: 'remote.platform.ios',
  android: 'remote.platform.android',
  web: 'remote.platform.web',
  other: 'remote.platform.generic'
}

/** The live remote-access status, refreshed by main whenever it changes. */
export function useRemoteStatus(): [RemoteStatusView | null, (s: RemoteStatusView) => void] {
  const [status, setStatus] = useState<RemoteStatusView | null>(null)
  useEffect(() => {
    let alive = true
    void window.hub.remote.status().then((s) => alive && setStatus(s))
    const off = window.hub.remote.onChanged((s) => alive && setStatus(s))
    return () => {
      alive = false
      off()
    }
  }, [])
  return [status, setStatus]
}

/** A QR image of the link, or null while it renders. */
function useQr(link: string | null): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!link) {
      setUrl(null)
      return
    }
    let alive = true
    void QRCode.toDataURL(link, { width: 256, margin: 1, errorCorrectionLevel: 'M' }).then((u) => alive && setUrl(u)).catch(() => alive && setUrl(null))
    return () => {
      alive = false
    }
  }, [link])
  return url
}

function CapabilityPicker({ value, onChange, disabled }: { value: RemoteCapability[]; onChange: (next: RemoteCapability[]) => void; disabled?: boolean }) {
  const { t } = useI18n()
  return (
    <div className="flex flex-col gap-1">
      {REMOTE_CAPABILITIES.map((cap) => (
        <label key={cap} className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={value.includes(cap)}
            disabled={disabled}
            onChange={(e) => onChange(e.target.checked ? [...value, cap] : value.filter((c) => c !== cap))}
          />
          <span className="min-w-0">
            <span className="block text-text">{t(CAPABILITY_LABEL[cap])}</span>
            <span className="block text-xs text-subtle">{t(CAPABILITY_HINT[cap])}</span>
          </span>
        </label>
      ))}
    </div>
  )
}

/** Settings → Remote access: the relay, pairing a phone with a QR, and the paired devices. */
export function RemoteSection() {
  const { t, locale } = useI18n()
  const [status, setStatus] = useRemoteStatus()
  const [relayDraft, setRelayDraft] = useState<string | null>(null)
  const [nameDraft, setNameDraft] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [grant, setGrant] = useState<RemoteCapability[]>([...REMOTE_CAPABILITIES])
  const [revoking, setRevoking] = useState<RemoteDeviceView | null>(null)
  const qr = useQr(status?.pairing?.link ?? null)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!status?.pairing) return
    const timer = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(timer)
  }, [status?.pairing])

  const act = async (op: () => Promise<RemoteStatusView>) => {
    setError(null)
    try {
      setStatus(await op())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const connectionText = useMemo(() => {
    if (!status) return ''
    if (status.connection === 'error') return t('remote.connection.error', { error: status.error ?? '' })
    return t(`remote.connection.${status.connection}` as MessageKey)
  }, [status, t])

  if (!status) return null
  const canPair = status.enabled && status.relayUrl.length > 0
  const minutesLeft = status.pairing ? Math.max(1, Math.ceil((status.pairing.expiresAt - now) / 60_000)) : 0
  const when = (ts: number) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(ts)

  return (
    <div className="flex flex-col gap-6" data-testid="settings-remote">
      <SettingsGroup anchor="relay" title={t('remote.group.relay')} footnote={status.enabled ? (status.pushAvailable ? t('remote.push.on') : t('remote.push.off')) : undefined}>
        <SwitchRow label={t('remote.enable')} hint={t('remote.enableHint')}>
          <Switch checked={status.enabled} aria-label={t('remote.enable')} onChange={(on) => void act(() => window.hub.remote.setEnabled(on))} />
        </SwitchRow>
        <div className="flex flex-col gap-3 py-3" data-settings-row>
          <Field label={t('remote.relayUrl')} hint={t('remote.relayUrlHint')} error={error ?? undefined}>
            <Input
              value={relayDraft ?? status.relayUrl}
              placeholder={t('remote.relayUrlPlaceholder')}
              onChange={(e) => setRelayDraft(e.target.value)}
              onBlur={() => {
                if (relayDraft !== null && relayDraft !== status.relayUrl) void act(() => window.hub.remote.setRelayUrl(relayDraft))
                setRelayDraft(null)
              }}
              spellCheck={false}
            />
          </Field>
          <Field label={t('remote.desktopName')} hint={t('remote.desktopNameHint')}>
            <Input
              value={nameDraft ?? status.desktopName}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={() => {
                if (nameDraft !== null && nameDraft !== status.desktopName) void act(() => window.hub.remote.setDesktopName(nameDraft))
                setNameDraft(null)
              }}
            />
          </Field>
          {status.fingerprint && (
            <Field label={t('remote.fingerprint')} hint={t('remote.fingerprintHint')}>
              <code className="select-all text-sm text-muted" data-testid="remote-fingerprint">
                {status.fingerprint}
              </code>
            </Field>
          )}
          <p className="text-xs text-subtle" data-testid="remote-connection">
            {connectionText}
          </p>
        </div>
      </SettingsGroup>

      <SettingsGroup anchor="pair" title={t('remote.group.pair')}>
        <div className="flex flex-col gap-3 py-3" data-settings-row>
          {!canPair && <p className="text-sm text-subtle">{t('remote.pair.needEnabled')}</p>}
          {canPair && !status.pairing && (
            <div>
              <Button variant="primary" icon={<QrCode className="size-4" aria-hidden />} onClick={() => void act(() => window.hub.remote.startPairing())}>
                {t('remote.pair.start')}
              </Button>
            </div>
          )}
          {status.pairing && !status.request && (
            <div className="flex flex-col items-start gap-3 sm:flex-row">
              {qr ? <img src={qr} alt="" width={200} height={200} className="rounded-md bg-white p-2" data-testid="remote-qr" /> : <div className="size-50 rounded-md bg-surface" />}
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <p className="text-sm text-text">{t('remote.pair.scan', { minutes: minutesLeft })}</p>
                <p className="text-xs text-subtle">{t('remote.pair.waiting')}</p>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" icon={<Copy className="size-3.5" aria-hidden />} onClick={() => void navigator.clipboard.writeText(status.pairing!.link)}>
                    {t('remote.pair.openLink')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void act(() => window.hub.remote.cancelPairing())}>
                    {t('remote.pair.cancel')}
                  </Button>
                </div>
              </div>
            </div>
          )}
          {status.request && (
            <div className="flex flex-col gap-3 rounded-md border border-accent/40 bg-accent/5 p-3" data-testid="remote-request">
              <div className="flex items-center gap-2">
                <Smartphone className="size-4 text-accent" aria-hidden />
                <span className="text-base font-medium">{t('remote.pair.request', { name: status.request.name })}</span>
                <Badge tone="info">{t(PLATFORM_LABEL[status.request.platform])}</Badge>
              </div>
              <code className="select-all text-sm text-muted">{status.request.fingerprint}</code>
              <p className="text-xs text-subtle">{t('remote.pair.requestHint')}</p>
              <CapabilityPicker value={grant} onChange={setGrant} />
              <div className="flex gap-2">
                <Button variant="primary" icon={<Check className="size-4" aria-hidden />} onClick={() => void act(() => window.hub.remote.acceptPairing(status.request!.deviceId, grant))}>
                  {t('remote.pair.accept')}
                </Button>
                <Button variant="ghost" icon={<X className="size-4" aria-hidden />} onClick={() => void act(() => window.hub.remote.rejectPairing(status.request!.deviceId))}>
                  {t('remote.pair.reject')}
                </Button>
              </div>
            </div>
          )}
        </div>
      </SettingsGroup>

      <SettingsGroup anchor="devices" title={t('remote.group.devices')}>
        {status.devices.length === 0 && <p className="py-3 text-sm text-subtle">{t('remote.devices.none')}</p>}
        {status.devices.map((device) => (
          <div key={device.id} className="flex flex-col gap-2 py-3" data-settings-row data-testid="remote-device">
            <div className="flex items-center gap-2">
              <Smartphone className="size-4 shrink-0 text-muted" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-base">{device.name}</span>
              <Badge tone="neutral">{t(PLATFORM_LABEL[device.platform])}</Badge>
              <Badge tone={device.online ? 'success' : 'neutral'}>{device.online ? t('remote.devices.online') : t('remote.devices.offline')}</Badge>
              <Button size="sm" variant="danger" onClick={() => setRevoking(device)}>
                {t('remote.devices.revoke')}
              </Button>
            </div>
            <code className="text-xs text-subtle">{device.fingerprint}</code>
            <p className="text-xs text-subtle">{device.lastSeenAt ? t('remote.devices.lastSeen', { when: when(device.lastSeenAt) }) : t('remote.devices.never')}</p>
            <CapabilityPicker value={device.capabilities} onChange={(next) => void act(() => window.hub.remote.setCapabilities(device.id, next))} />
          </div>
        ))}
      </SettingsGroup>
      {revoking && (
        <ConfirmDeleteDialog
          open
          name={revoking.name}
          title={t('remote.devices.revokeConfirm', { name: revoking.name })}
          confirmLabel={t('remote.devices.revoke')}
          onOpenChange={(open) => {
            if (!open) setRevoking(null)
          }}
          onConfirm={() => {
            const id = revoking.id
            setRevoking(null)
            void act(() => window.hub.remote.revoke(id))
          }}
        />
      )}
    </div>
  )
}
