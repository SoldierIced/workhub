import { useCallback, useEffect, useRef, useState } from 'react'
import type { SetupFix, SetupItem } from '@workhub/core'
import type { MessageKey, Params, PluralKey } from '../i18n/translate'

type T = (key: MessageKey, params?: Params) => string
type TN = (base: PluralKey, count: number, params?: Params) => string

/** The row's title in the user's language. */
export function itemTitle(t: T, item: SetupItem): string {
  return t(`setup.item.${item.kind}` as MessageKey, item.params)
}

/** The row's one-line detail: what was found, or what to do about it. */
export function itemDetail(t: T, tn: TN, item: SetupItem): string {
  const p = item.params
  switch (item.code) {
    case 'signedInAs':
      if (!p['who']) return t('setup.msg.signedIn')
      return p['plan'] ? t('setup.msg.signedInPlan', { who: p['who'], plan: p['plan'] }) : t('setup.msg.signedInAs', { who: p['who'] })
    case 'profileFolders':
      return tn('setup.msg.profileFolders', Number(p['count']), { names: p['names'] ?? '' })
    case 'slackOn':
      return tn('setup.msg.slackOn', Number(p['count']))
    default:
      return t(`setup.msg.${item.code}` as MessageKey, p)
  }
}

/** The label of a row's fix button. */
export function fixLabel(t: T, fix: SetupFix): string {
  switch (fix.kind) {
    case 'settings':
      return t('setup.openSettings', { tab: t(`setup.tab.${fix.tab}` as MessageKey) })
    case 'link':
      return t(`setup.link.${fix.title}` as MessageKey)
    case 'command':
      return t('setup.copy')
  }
}

export type SetupState = { items: SetupItem[]; running: boolean; failed: boolean; run: () => void }

/** Runs the setup check on mount and again on demand; an older run never overwrites a newer one. */
export function useSetupCheck(): SetupState {
  const [items, setItems] = useState<SetupItem[]>([])
  const [running, setRunning] = useState(true)
  const [failed, setFailed] = useState(false)
  const generation = useRef(0)
  const run = useCallback(() => {
    const mine = ++generation.current
    setRunning(true)
    setFailed(false)
    window.hub.setup.run().then(
      (next) => {
        if (mine !== generation.current) return
        setItems(next)
        setRunning(false)
      },
      () => {
        if (mine !== generation.current) return
        setFailed(true)
        setRunning(false)
      }
    )
  }, [])
  useEffect(run, [run])
  return { items, running, failed, run }
}
