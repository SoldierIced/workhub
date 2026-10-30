import { hasUnread, type TrackedThread } from '@workhub/core'
import type { HealthView } from '@shared/health-api'
import type { MessageKey } from '../i18n/translate'
import { STATE_ORDER } from './health'
import type { Route } from './nav'
import { ROUTE_LABEL } from './routes'

/** Open Slack threads with replies the user has not seen, for the Slack button's count. */
export function slackUnreadCount(threads: readonly TrackedThread[] | undefined, me: string): number {
  return (threads ?? []).filter((th) => !th.closed && hasUnread(th, me)).length
}

/** The worst state over the Health environments that were read; null before any read. */
export function worstHealthState(view: Pick<HealthView, 'environments'> | null | undefined): (typeof STATE_ORDER)[number] | null {
  const states = (view?.environments ?? []).map((e) => e.snapshot.state)
  if (!states.length) return null
  return [...states].sort((a, b) => STATE_ORDER.indexOf(a) - STATE_ORDER.indexOf(b))[0]!
}

/** The top bar's labels: short where the sidebar's is long ("History" for "Session history"); when the bar is tight, shorter still ("PRs", "Maps"). */
export function topNavLabel(route: Route, tight = false): MessageKey {
  if (route === 'history') return 'topNav.history'
  if (tight && route === 'pullRequests') return 'topNav.pullRequests'
  if (tight && route === 'flowMaps') return 'topNav.flowMaps'
  return ROUTE_LABEL[route]
}
