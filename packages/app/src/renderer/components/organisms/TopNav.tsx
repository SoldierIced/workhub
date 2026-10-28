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
 * gets too narrow it first tightens the spacing, then shows icons only (the active screen keeps
 * its label), and last icons only everywhere; the tooltip names the screen and its key.
 */
export function TopNav({ items, route, onNavigate, profileId }: TopNavProps) {
  const { t, tn } = useI18n()
  const platform = usePlatform()
  const slack = useSlack()
  const healthOn = items.some((i) => i.route === 'health')
  const { view: health } = useHealth(profileId, healthOn)
  const lists = useCachedPullRequestLists(profileId)
  const navRef = useRef<HTMLElement>(null)
  // How far the bar folded at this width (0 full, 1 tight, 2 icons but the active label, 3 icons
  // only); a new width starts again from the full bar.
  const [fold, setFold] = useState<{ width: number; level: number }>({ width: 0, level: 0 })
  const [width, setWidth] = useState(0)
  const level = fold.width === width ? fold.level : 0
  const iconsOnly = level >= 3

  useLayoutEffect(() => {
    const el = navRef.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => e && setWidth(Math.round(e.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  useLayoutEffect(() => {
    const el = navRef.current
    if (!el || level >= 3 || width === 0) return
    if (el.scrollWidth > el.clientWidth + 1) setFold({ width, level: level + 1 })
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
        const labelled = level < 2 || (level === 2 && active)
        return (
          <button
            key={item.route}
            type="button"
            onClick={() => onNavigate(item.route)}
            aria-current={active ? 'page' : undefined}
            aria-label={labelled ? undefined : [name, note].filter(Boolean).join(', ')}
            title={tip}
            data-route={item.route}
            className={cn(
              'relative inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md text-sm whitespace-nowrap transition-colors duration-150',
              !labelled ? 'px-2' : level >= 1 ? 'px-1.5' : 'px-2.5',
              active ? 'bg-accent-soft font-medium text-text' : 'text-muted hover:bg-surface-hover hover:text-text'
            )}
          >
            <Icon className={cn('size-4 shrink-0', active ? 'text-accent' : 'text-subtle')} aria-hidden />
            {labelled && <span>{t(topNavLabel(item.route))}</span>}
            {badge && <span className={cn('inline-flex items-center', !labelled && 'pointer-events-none absolute top-0 right-0 scale-90')}>{badge}</span>}
          </button>
        )
      })}
    </nav>
  )
}
