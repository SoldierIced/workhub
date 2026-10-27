import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useSlack } from '../../chatStore'
import { useHealth } from '../../healthStore'
import { useI18n } from '../../i18n/I18nProvider'
import { cn } from '../../lib/cn'
import { HEALTH_LABEL, HEALTH_TONE } from '../../lib/health'
import type { NavItem, Route } from '../../lib/nav'
import { usePlatform } from '../../lib/platform'
import { ROUTE_ICON, ROUTE_LABEL } from '../../lib/routes'
import { shortcutLabel } from '../../lib/shortcuts'
import { slackUnreadCount, topNavLabel, worstHealthState } from '../../lib/topNav'
import { useCachedPullRequestLists } from '../../pullRequestsStore'
import { StateDot } from '../atoms/StateDot'

export interface TopNavProps {
  items: NavItem[]
  route: Route
  onNavigate: (route: Route) => void
  profileId: string | null
}

function Count({ value, label }: { value: number; label: string }) {
  return (
    <span className="rounded-full bg-accent-soft px-1.5 text-2xs leading-4 font-semibold tabular-nums text-accent" title={label}>
      {value > 99 ? '99+' : value}
      <span className="sr-only"> {label}</span>
    </span>
  )
}

/**
 * The screens, in the window's top bar: icon and short label, the active one highlighted, with
 * their counts (pull requests to review, unread Slack threads) and Health's state. When the bar
 * gets too narrow for the labels it shows icons only; the tooltip names the screen and its key.
 */
export function TopNav({ items, route, onNavigate, profileId }: TopNavProps) {
  const { t, tn } = useI18n()
  const platform = usePlatform()
  const slack = useSlack()
  const healthOn = items.some((i) => i.route === 'health')
  const { view: health } = useHealth(profileId, healthOn)
  const lists = useCachedPullRequestLists(profileId)
  const navRef = useRef<HTMLElement>(null)
  // The width at which the labels did not fit; a new width tries them again.
  const [fold, setFold] = useState<{ width: number; iconsOnly: boolean }>({ width: 0, iconsOnly: false })
  const [width, setWidth] = useState(0)
  const iconsOnly = fold.width === width && fold.iconsOnly

  useLayoutEffect(() => {
    const el = navRef.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => e && setWidth(Math.round(e.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  useLayoutEffect(() => {
    const el = navRef.current
    if (!el || iconsOnly || width === 0) return
    if (el.scrollWidth > el.clientWidth + 1) setFold({ width, iconsOnly: true })
  })

  const unread = slack && slack.health !== 'off' ? slackUnreadCount(slack.threads, slack.me) : 0
  const toReview = lists?.toReview.length ?? 0
  const healthState = healthOn ? worstHealthState(health) : null

  const extra = (r: Route): { badge: ReactNode; note?: string } => {
    if (r === 'slack' && unread > 0) {
      const note = tn('topNav.slackUnread', unread)
      return { badge: <Count value={unread} label={note} />, note }
    }
    if (r === 'pullRequests' && toReview > 0) {
      const note = tn('topNav.prsToReview', toReview)
      return { badge: <Count value={toReview} label={note} />, note }
    }
    if (r === 'health' && healthState) {
      const note = t('topNav.health', { state: t(HEALTH_LABEL[healthState]) })
      return { badge: <StateDot tone={HEALTH_TONE[healthState]} pulse={healthState === 'degraded'} />, note }
    }
    return { badge: null }
  }

  return (
    <nav ref={navRef} aria-label={t('topNav.label')} data-testid="top-nav" data-icons-only={iconsOnly || undefined} className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden">
      {items.map((item) => {
        const Icon = ROUTE_ICON[item.route]
        const active = route === item.route
        const name = t(ROUTE_LABEL[item.route])
        const { badge, note } = extra(item.route)
        const tip = [`${name} (${shortcutLabel(item.shortcut, platform)})`, note].filter(Boolean).join('\n')
        return (
          <button
            key={item.route}
            type="button"
            onClick={() => onNavigate(item.route)}
            aria-current={active ? 'page' : undefined}
            aria-label={iconsOnly ? [name, note].filter(Boolean).join(', ') : undefined}
            title={tip}
            data-route={item.route}
            className={cn(
              'relative inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md text-sm whitespace-nowrap transition-colors duration-150',
              iconsOnly ? 'px-2' : 'px-2.5',
              active ? 'bg-accent-soft font-medium text-text' : 'text-muted hover:bg-surface-hover hover:text-text'
            )}
          >
            <Icon className={cn('size-4 shrink-0', active ? 'text-accent' : 'text-subtle')} aria-hidden />
            {!iconsOnly && <span>{t(topNavLabel(item.route))}</span>}
            {badge && <span className={cn('inline-flex items-center', iconsOnly && 'pointer-events-none absolute top-0 right-0 scale-90')}>{badge}</span>}
          </button>
        )
      })}
    </nav>
  )
}
