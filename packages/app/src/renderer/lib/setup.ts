import { useCallback, useEffect, useRef, useState } from 'react'
import { problemCount, type SetupFix, type SetupItem } from '@workhub/core'
import type { MessageKey, Params, PluralKey } from '../i18n/translate'

type T = (key: MessageKey, params?: Params) => string
type TN = (base: PluralKey, count: number, params?: Params) => string

/** The row's title in the user's language. */
export function itemTitle(t: T, item: SetupItem): string {
  const title = t(`setup.item.${item.kind}` as MessageKey, item.params)
  // Checked inside the WSL distribution the active profile runs in.
  const host = item.params['host']
  return host ? t('setup.inHost', { title, host }) : title
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
    case 'adminCommand':
      return t('setup.copy')
    case 'install':
      return t('setup.install')
    case 'signIn':
      return t('setup.signIn')
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
  // A sign-in that finished in its own window, or a tool removed in Settings: read it again.
  useEffect(() => window.hub.setup.onChanged(run), [run])
  return { items, running, failed, run }
}

/** Home reads the check at most this often: it runs a dozen commands. */
export const SETUP_PROBLEMS_MAX_AGE_MS = 5 * 60_000
/** While Home shows a problem, coming back to the window reads it again after this long: the fix is usually made in another window. */
export const SETUP_PROBLEMS_RECHECK_MS = 10_000

/** Whether coming back to the window should read the check again: only while a problem shows, and not more often than the short age. */
export function recheckOnFocus(last: { at: number; count: number } | null, now: number): boolean {
  return last !== null && last.count > 0 && now - last.at >= SETUP_PROBLEMS_RECHECK_MS
}
let lastProblems: { at: number; count: number } | null = null

/**
 * How many needed rows are not ready (for Home's banner), from a check at most a few minutes old;
 * null until it answers or when it fails. A new `needsKey` (what is needed changed: the goal, an
 * agent or a code host) reads it again; an empty one (no settings yet) waits.
 */
export function useSetupProblems(needsKey: string): number | null {
  const [count, setCount] = useState<number | null>(lastProblems?.count ?? null)
  const seen = useRef(needsKey)
  useEffect(() => {
    if (!needsKey) return
    const changed = seen.current !== needsKey
    seen.current = needsKey
    if (!changed && lastProblems && Date.now() - lastProblems.at < SETUP_PROBLEMS_MAX_AGE_MS) return setCount(lastProblems.count)
    let live = true
    window.hub.setup.run().then(
      (items) => {
        lastProblems = { at: Date.now(), count: problemCount(items) }
        if (live) setCount(lastProblems.count)
      },
      () => live && setCount(null)
    )
    return () => {
      live = false
    }
  }, [needsKey])
  useEffect(() => {
    const onFocus = () => {
      if (!recheckOnFocus(lastProblems, Date.now())) return
      // Marked read now, so a burst of focus events starts one check.
      lastProblems = { at: Date.now(), count: lastProblems!.count }
      window.hub.setup.run().then(
        (items) => {
          lastProblems = { at: Date.now(), count: problemCount(items) }
          setCount(lastProblems.count)
        },
        () => undefined
      )
    }
    window.addEventListener('focus', onFocus)
    // A sign-in finished or a tool was removed: the count may have changed, whatever its age.
    const off = window.hub.setup.onChanged(() => {
      window.hub.setup.run().then(
        (items) => {
          lastProblems = { at: Date.now(), count: problemCount(items) }
          setCount(lastProblems.count)
        },
        () => undefined
      )
    })
    return () => {
      window.removeEventListener('focus', onFocus)
      off()
    }
  }, [])
  return count
}
