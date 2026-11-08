import { useEffect, useState } from 'react'
import { useI18n } from '../../renderer/i18n/I18nProvider'
import type { LanguagePreference } from '../../renderer/i18n/translate'
import type { ThemePreference } from '../../shared/api'
import { TEXT_SIZE_CHOICES } from '../appearance'
import { setPrefs, usePrefs } from '../../renderer/lib/prefs'
import { REMOTE_CAPABILITIES } from '../../shared/remote-api'
import { navigate, useClient, useClientStatus, useConfig, useProfileId } from '../app-context'
import { currentPushSubscription, isStandalone, pushSupported, subscribeToPush, unsubscribeFromPush } from '../browser'
import { Body, Header, InlineConfirm, Row, Screen, SectionTitle } from '../ui'

const CAPABILITY_KEY = { sessions: 'web.capability.sessions', pullRequests: 'web.capability.pullRequests', automations: 'web.capability.automations', health: 'web.capability.health', plan: 'web.capability.plan' } as const
const SELECT = 'h-8 rounded-md border border-border-strong bg-surface px-2 text-sm text-text'

/** The phone's own settings: the pairing, notifications, language, and unpairing. */
export function SettingsScreen() {
  const { t } = useI18n()
  const client = useClient()
  const status = useClientStatus()
  const prefs = usePrefs()
  const [pushOn, setPushOn] = useState<boolean | null>(null)
  const [pushError, setPushError] = useState<string | null>(null)
  const [unpairing, setUnpairing] = useState(false)
  const desktop = status.desktop
  const { config } = useConfig()
  const [profileId, setProfileId] = useProfileId(config)
  const profiles = config?.config.profiles ?? []

  useEffect(() => {
    void currentPushSubscription().then((sub) => setPushOn(!!sub && Notification.permission === 'granted'))
  }, [])

  const togglePush = async () => {
    setPushError(null)
    try {
      if (pushOn) {
        await unsubscribeFromPush()
        client.setPushSubscription(null)
        setPushOn(false)
      } else if (status.vapidPublicKey) {
        const sub = await subscribeToPush(status.vapidPublicKey)
        if (!sub) {
          setPushError(Notification.permission === 'denied' ? t('web.notify.denied') : t('web.notify.unsupported'))
          return
        }
        client.setPushSubscription(sub)
        setPushOn(true)
      }
    } catch (err) {
      setPushError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <Screen>
      <Header title={t('web.settings.title')} back={desktop ? undefined : { screen: 'home' }} />
      <Body>
        {desktop && (
          <>
            <SectionTitle>{t('web.settings.desktop')}</SectionTitle>
            <div className="mx-4 rounded-xl border border-border bg-surface">
              <Row>
                <div className="text-md font-medium">{desktop.name}</div>
                <div className="text-xs text-muted">{status.state === 'online' ? t('web.state.online', { desktop: desktop.name }) : t('web.state.desktopOffline', { desktop: desktop.name })}</div>
              </Row>
              <Row className="border-t border-border">
                <div className="text-xs text-muted">{t('web.settings.desktopFingerprint')}</div>
                <div className="fp text-sm">{displayGroups(desktop.id)}</div>
              </Row>
              <Row className="border-t border-border">
                <div className="text-xs text-muted">{t('web.settings.capabilities')}</div>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {REMOTE_CAPABILITIES.filter((c) => desktop.capabilities.includes(c)).map((c) => (
                    <span key={c} className="rounded-full bg-accent-soft px-2 py-px text-xs font-medium text-accent">
                      {t(CAPABILITY_KEY[c])}
                    </span>
                  ))}
                </div>
              </Row>
            </div>
          </>
        )}

        <SectionTitle>{t('web.pair.thisPhone')}</SectionTitle>
        <div className="mx-4 rounded-xl border border-border bg-surface">
          <Row>
            <div className="text-xs text-muted">{t('web.settings.deviceFingerprint')}</div>
            <div className="fp text-sm">{status.fingerprint}</div>
          </Row>
          {desktop && (
            <Row
              className="border-t border-border"
              right={
                pushSupported() && pushOn !== null ? (
                  <button type="button" onClick={() => void togglePush()} className="h-8 rounded-md border border-border-strong px-3 text-sm">
                    {pushOn ? t('web.settings.disableNotifications') : t('web.settings.enableNotifications')}
                  </button>
                ) : undefined
              }
            >
              <div className="text-md font-medium">{t('web.settings.notifications')}</div>
              <div className="text-xs text-muted">{!pushSupported() ? t('web.notify.unsupported') : pushOn ? t('web.settings.notificationsOn') : t('web.settings.notificationsOff')}</div>
              {pushError && <div className="mt-1 text-xs text-danger">{pushError}</div>}
              {!isStandalone() && /iPhone|iPad/.test(navigator.userAgent) && <div className="mt-1 text-xs text-info">{t('web.settings.install')}</div>}
            </Row>
          )}
        </div>

        <SectionTitle>{t('web.settings.appearance')}</SectionTitle>
        <div className="mx-4 rounded-xl border border-border bg-surface">
          <Row
            right={
              <select value={prefs.language} onChange={(e) => setPrefs({ language: e.target.value as LanguagePreference })} aria-label={t('web.settings.language')} className={SELECT}>
                <option value="system">{t('web.settings.language.system')}</option>
                <option value="en">{t('web.settings.language.en')}</option>
                <option value="es">{t('web.settings.language.es')}</option>
              </select>
            }
          >
            <div className="text-md font-medium">{t('web.settings.language')}</div>
          </Row>
          <Row
            className="border-t border-border"
            right={
              <select value={prefs.theme} onChange={(e) => setPrefs({ theme: e.target.value as ThemePreference })} aria-label={t('web.settings.theme')} className={SELECT}>
                <option value="system">{t('web.settings.theme.system')}</option>
                <option value="light">{t('web.settings.theme.light')}</option>
                <option value="dark">{t('web.settings.theme.dark')}</option>
              </select>
            }
          >
            <div className="text-md font-medium">{t('web.settings.theme')}</div>
          </Row>
          <Row
            className="border-t border-border"
            right={
              <select value={String(prefs.textSize)} onChange={(e) => setPrefs({ textSize: Number(e.target.value) })} aria-label={t('web.settings.textSize')} className={SELECT}>
                {TEXT_SIZE_CHOICES.map((c) => (
                  <option key={c.key} value={String(c.size)}>
                    {t(`web.settings.textSize.${c.key}`)}
                  </option>
                ))}
              </select>
            }
          >
            <div className="text-md font-medium">{t('web.settings.textSize')}</div>
          </Row>
          {desktop && profiles.length > 1 && (
            <Row
              className="border-t border-border"
              right={
                <select value={profileId ?? ''} onChange={(e) => setProfileId(e.target.value || null)} aria-label={t('web.settings.profile')} className={SELECT}>
                  {profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              }
            >
              <div className="text-md font-medium">{t('web.settings.profile')}</div>
              <div className="text-xs text-muted">{t('web.settings.profileHint')}</div>
            </Row>
          )}
        </div>

        {desktop && (
          <div className="mx-4 mt-6 mb-6">
            {unpairing ? (
              <InlineConfirm
                question={t('web.settings.unpairConfirm', { desktop: desktop.name })}
                yes={t('web.settings.unpairYes')}
                danger
                onNo={() => setUnpairing(false)}
                onYes={() => {
                  setUnpairing(false)
                  void unsubscribeFromPush().catch(() => {})
                  client.unpair()
                  navigate({ screen: 'home' }, true)
                }}
              />
            ) : (
              <button type="button" onClick={() => setUnpairing(true)} className="h-11 w-full rounded-xl border border-danger/40 bg-danger-soft text-sm font-medium text-danger">
                {t('web.settings.unpair')}
              </button>
            )}
          </div>
        )}
      </Body>
    </Screen>
  )
}

/** A fingerprint in groups of four, as the desktop shows it. */
function displayGroups(id: string): string {
  return (id.toUpperCase().match(/.{1,4}/g) ?? [id]).join(' ')
}
