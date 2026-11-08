import { Check, ClipboardPaste, Smartphone } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Spinner } from '../../renderer/components/atoms'
import { useI18n } from '../../renderer/i18n/I18nProvider'
import { navigate, useClient, useClientStatus, useRoute } from '../app-context'
import { DEVICE_NAME_KEY } from '../device'
import { BigButton, Screen } from '../ui'

/**
 * The first screen, and the one a pairing link opens: shows this phone's fingerprint, then the
 * desktop's offer to confirm, then waits for the desktop to accept.
 */
export function PairScreen({ defaultName }: { defaultName: string }) {
  const { t } = useI18n()
  const client = useClient()
  const status = useClientStatus()
  const [name, setName] = useState(() => localStorage.getItem(DEVICE_NAME_KEY) ?? defaultName)
  const [linkError, setLinkError] = useState<string | null>(null)
  const [pasted, setPasted] = useState('')
  const route = useRoute()

  // The app installed on the home screen has no address bar, and on iOS a tapped link or a scanned
  // QR opens the browser instead of the installed app: the link can be pasted here.
  const openPasted = () => {
    const link = pasted.trim()
    if (!link) return
    const ok = client.openPairingLink(link)
    setLinkError(ok ? null : client.status().error === 'expired' ? t('web.pair.expired') : t('web.pair.invalid'))
    if (ok) setPasted('')
  }

  // A pairing link in the hash (on load, or opened into the running app): read it, then clear it so a reload does not re-offer it.
  useEffect(() => {
    if (route.screen !== 'pair' || !location.hash.startsWith('#pair=')) return
    const ok = client.openPairingLink(location.href)
    navigate({ screen: 'home' }, true)
    if (!ok) setLinkError(client.status().error === 'expired' ? t('web.pair.expired') : t('web.pair.invalid'))
  }, [client, t, route])

  const confirm = () => {
    localStorage.setItem(DEVICE_NAME_KEY, name.trim() || defaultName)
    client.pair()
  }

  if (status.state === 'pairing') {
    return (
      <Screen>
        <div className="safe-top flex flex-1 flex-col items-center justify-center gap-4 px-8 text-center">
          <Spinner className="size-8" />
          <h1 className="text-xl font-semibold">{t('web.pair.waiting')}</h1>
          <p className="text-sm text-muted">{t('web.pair.waitingHint')}</p>
          {status.error === 'desktop-offline' && <p className="text-sm text-warning">{t('web.pair.desktopOffline')}</p>}
          <div className="w-full rounded-xl border border-border bg-surface p-4 text-left">
            <div className="text-xs font-semibold tracking-wide text-muted uppercase">{t('web.pair.thisPhone')}</div>
            <div className="fp mt-1 text-md">{status.fingerprint}</div>
            <div className="mt-1 text-xs text-subtle">{t('web.pair.fingerprintHint')}</div>
          </div>
          <div className="safe-bottom w-full pt-2">
            <BigButton variant="secondary" onClick={() => client.cancelPairing()}>
              {t('web.cancel')}
            </BigButton>
          </div>
        </div>
      </Screen>
    )
  }

  if (status.offer) {
    return (
      <Screen>
        <div className="safe-top flex flex-1 flex-col gap-5 px-6 pt-10">
          <span className="flex size-16 items-center justify-center self-center rounded-2xl bg-accent-soft text-accent">
            <Smartphone className="size-8" aria-hidden />
          </span>
          <h1 className="text-center text-xl font-semibold">{t('web.pair.offerTitle', { desktop: status.offer.desktopName })}</h1>
          <p className="text-center text-sm text-muted">{t('web.pair.offerHint')}</p>
          <div className="rounded-xl border border-border bg-surface p-4">
            <div className="text-xs font-semibold tracking-wide text-muted uppercase">{t('web.pair.desktopFingerprint')}</div>
            <div className="fp mt-1 text-md">{status.offer.desktopFingerprint}</div>
            <div className="mt-3 text-xs font-semibold tracking-wide text-muted uppercase">{t('web.pair.thisPhone')}</div>
            <div className="fp mt-1 text-md">{status.fingerprint}</div>
          </div>
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium text-muted">{t('web.pair.deviceName')}</span>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} className="h-12 rounded-xl border border-border-strong bg-surface px-4 text-md text-text" />
          </label>
          <div className="safe-bottom mt-auto flex flex-col gap-2 pb-4">
            <BigButton onClick={confirm}>
              <Check className="size-5" aria-hidden />
              {t('web.pair.confirm')}
            </BigButton>
            <BigButton variant="secondary" onClick={() => client.cancelPairing()}>
              {t('web.cancel')}
            </BigButton>
          </div>
        </div>
      </Screen>
    )
  }

  return (
    <Screen>
      <div className="safe-top flex flex-1 flex-col gap-5 px-6 pt-12">
        <span className="flex size-16 items-center justify-center self-center rounded-2xl bg-accent-soft text-accent">
          <Smartphone className="size-8" aria-hidden />
        </span>
        <h1 className="text-center text-xl font-semibold">{t('web.pair.title')}</h1>
        <p className="text-center text-sm text-muted">{t('web.pair.intro')}</p>
        {(linkError || status.state === 'revoked') && <p className="rounded-lg bg-danger-soft px-3 py-2 text-center text-sm text-danger">{linkError ?? t('web.state.revoked')}</p>}
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            openPasted()
          }}
        >
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium text-muted">{t('web.pair.pasteLabel')}</span>
            <input
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              placeholder="https://…/#pair=…"
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className="h-12 rounded-xl border border-border-strong bg-surface px-4 text-md text-text"
            />
          </label>
          <BigButton type="submit" disabled={!pasted.trim()}>
            <ClipboardPaste className="size-5" aria-hidden />
            {t('web.pair.pasteOpen')}
          </BigButton>
        </form>
        <div className="rounded-xl border border-border bg-surface p-4">
          <div className="text-xs font-semibold tracking-wide text-muted uppercase">{t('web.pair.thisPhone')}</div>
          <div className="fp mt-1 text-md">{status.fingerprint}</div>
          <div className="mt-1 text-xs text-subtle">{t('web.pair.fingerprintHint')}</div>
        </div>
        <div className="safe-bottom mt-auto pb-4">
          <BigButton variant="secondary" onClick={() => navigate({ screen: 'settings' })}>
            {t('web.nav.settings')}
          </BigButton>
        </div>
      </div>
    </Screen>
  )
}
