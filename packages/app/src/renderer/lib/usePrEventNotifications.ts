import { useEffect } from 'react'
import { appOptions } from '@workhub/core'
import type { ConfigSnapshot } from '@shared/api'
import type { I18n } from '../i18n/I18nProvider'
import { isNotifiable, prNotificationText } from './prEvents'

/**
 * Pull request events arrive from the main process once each. The ones Settings allows are worded
 * in the interface language and handed back to be shown as OS notifications; a click on one opens
 * the pull request window. The renderer tells main when it listens, so events found during the
 * start-up are not lost.
 */
export function usePrEventNotifications(latest: () => { snap: ConfigSnapshot | null } & Pick<I18n, 't' | 'tn'>): void {
  useEffect(() => {
    const off = window.hub.prEvents.onEvents(({ profileId, events }) => {
      const { snap, t, tn } = latest()
      const toggles = appOptions(snap?.config ?? { options: undefined }).notifyPrEvents
      for (const event of events) {
        if (isNotifiable(event, toggles)) window.hub.prEvents.notify({ profileId, url: event.url, ...prNotificationText(event, { t, tn }) })
      }
    })
    window.hub.prEvents.ready()
    return off
    // `latest` reads a ref; the subscription lives as long as the window.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}
