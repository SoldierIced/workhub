/**
 * Session continuity in the renderer: the usage-limit offers main sends (one per session, shown
 * above its composer until acted on or dismissed), following a session main moved by itself, and
 * the two actions (continue in another account, hand off to another agent).
 */
import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { SessionOrigin } from '@workhub/core'
import type { SessionView } from '@shared/api'
import type { ContinuityOffer, FailoverRequest } from '@shared/continuity-api'
import { useToast } from '../components/molecules'
import { useI18n } from '../i18n/I18nProvider'
import type { MessageKey } from '../i18n/translate'
import { flagAttention } from '../store'
import { setComposerDraft } from './drafts'
import { errorText } from './errorText'

let offers: Record<string, ContinuityOffer> = {}
const listeners = new Set<() => void>()
const openListeners = new Set<(id: string) => void>()

function setOffers(next: Record<string, ContinuityOffer>): void {
  offers = next
  for (const l of listeners) l()
}

export function dismissOffer(sessionId: string): void {
  if (!offers[sessionId]) return
  const { [sessionId]: _gone, ...rest } = offers
  setOffers(rest)
}

export function useContinuityOffer(sessionId: string): ContinuityOffer | undefined {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => offers[sessionId]
  )
}

/** Asks the app to show a session (App owns the selection). */
function requestOpen(id: string): void {
  for (const l of openListeners) l(id)
}

/** "Personal" out of "Claude Code - Personal": the account part of an agent label. */
export function accountOfLabel(label: string): string {
  const at = label.lastIndexOf(' - ')
  return at < 0 ? label : label.slice(at + 3)
}

/** The chat line of a session that continues another one. */
export function originText(origin: SessionOrigin, view: Pick<SessionView, 'label' | 'accountName'>, t: (key: MessageKey, params?: Record<string, string | number>) => string): string {
  if (origin.kind === 'handoff') return t('continuity.origin.handoff', { from: origin.fromLabel })
  const account = view.accountName ?? accountOfLabel(view.label)
  const from = accountOfLabel(origin.fromLabel)
  const params = { account, from, window: origin.window ?? '' }
  if (origin.reason === 'manual') return t('continuity.origin.failoverManual', params)
  if (origin.reason === 'ceiling') return t(origin.window ? 'continuity.origin.failoverCeiling' : 'continuity.origin.failoverCeilingNoWindow', params)
  return t(origin.window ? 'continuity.origin.failover' : 'continuity.origin.failoverNoWindow', params)
}

/** The continuity actions a session pane offers; each reports success or failure as a toast. */
export function useContinuityActions() {
  const { t } = useI18n()
  const toast = useToast()
  const failover = async (view: SessionView, request: FailoverRequest): Promise<boolean> => {
    try {
      const next = await window.hub.continuity.failover(view.id, request)
      dismissOffer(view.id)
      requestOpen(next.id)
      toast(t('continuity.toast.moved', { account: next.accountName ?? accountOfLabel(next.label) }))
      return true
    } catch (e) {
      toast(t('continuity.toast.failed', { message: errorText(e) }), 'danger')
      return false
    }
  }
  const handoff = async (view: SessionView, targetKey: string, label: string, summarize = false): Promise<boolean> => {
    try {
      const r = await window.hub.continuity.handoff(view.id, { targetKey, summarize })
      setComposerDraft(r.view.id, r.brief)
      dismissOffer(view.id)
      requestOpen(r.view.id)
      toast(r.summaryFailed ? t('continuity.toast.summaryFailed') : t('continuity.toast.handedOff', { agent: label }), r.summaryFailed ? 'danger' : undefined)
      return true
    } catch (e) {
      toast(t('continuity.toast.failed', { message: errorText(e) }), 'danger')
      return false
    }
  }
  return { failover, handoff }
}

/**
 * Mounted once by App: keeps the offers, flags the session (and notifies) when one arrives, and
 * follows a session main moved by itself so the screen does not go blank.
 */
export function useContinuity(openSession: (id: string) => void, selectedId: string | null): void {
  const { t } = useI18n()
  const selected = useRef(selectedId)
  selected.current = selectedId
  useEffect(() => {
    openListeners.add(openSession)
    return () => {
      openListeners.delete(openSession)
    }
  }, [openSession])
  useEffect(
    () =>
      window.hub.continuity.onOffer((offer) => {
        setOffers({ ...offers, [offer.sessionId]: offer })
        flagAttention(offer.sessionId, 'needsAnswer')
        window.hub.notifications.show({ title: t('continuity.notify.title', { account: offer.accountLabel }), body: t('continuity.notify.body'), sessionId: offer.sessionId })
      }),
    [t]
  )
  useEffect(
    () =>
      window.hub.continuity.onMoved((moved) => {
        dismissOffer(moved.fromId)
        if (selected.current === moved.fromId) openSession(moved.toId)
      }),
    [openSession]
  )
}
