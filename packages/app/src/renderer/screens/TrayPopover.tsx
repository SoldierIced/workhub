import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Bell, BellOff, CalendarDays, ChevronDown, ChevronLeft, ChevronRight, Download, GitPullRequest, ListTodo, MoreHorizontal, Plus, Power, Settings, Video, X } from 'lucide-react'
import { hasToday, pauseUntil, type TrayAction, type TrayPopoverMeeting, type TrayPopoverSession, type TrayPopoverUsage, type TrayPopoverView, type TrayRoute, type TrayTone } from '@workhub/core'
import type { MessageKey } from '../i18n/translate'
import { usageWindowName } from '../lib/usage-window'
import { Badge } from '../components/atoms'
import { AgentIcon } from '../components/atoms/AgentIcon'
import { I18nProvider, useI18n } from '../i18n/I18nProvider'
import { cn } from '../lib/cn'
import { usePlatform } from '../lib/platform'
import { setPrefs, usePrefs } from '../lib/prefs'
import { APP_TOKEN_NAMES } from '../lib/terminalThemes'
import {
  BAR_CLASS,
  countdown,
  DOT_CLASS,
  elapsed,
  nextFocus,
  overflowRow,
  popoverMenuItems,
  quietHoursValue,
  recentContext,
  recentExpanded,
  sessionChip,
  usageBlock,
  type OverflowList,
  type PopoverMenuId,
  type PopoverMenuItem
} from '../lib/trayPopover'

const perform = (action: TrayAction) => window.hub.tray.popover.perform(action)
const go = (route: TrayRoute) => perform({ kind: 'navigate', route })

/**
 * Every line of the popover: a flat row (no box) on the window's material. Heights are whole
 * pixels (28 px, 32 px with a second line) so nothing lands on half a pixel at 125 % or 150 %.
 */
const ROW = 'flex min-h-7 w-full items-center gap-2 rounded-md px-2 text-left text-sm leading-4 text-text transition-colors hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none'
const ROW_TWO_LINES = 'min-h-8'
const VALUE = 'shrink-0 text-xs tabular-nums text-muted'
const TONE_TEXT: Record<TrayTone, string> = { neutral: 'text-muted', success: 'text-success', info: 'text-info', warning: 'text-warning', danger: 'text-danger' }
const ICON_BUTTON = 'inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-hover hover:text-text focus-visible:bg-surface-hover focus-visible:outline-none'
const SMALL_BUTTON = 'inline-flex h-6 items-center gap-0.5 rounded px-1.5 text-xs text-muted transition-colors hover:bg-surface-hover hover:text-text focus-visible:bg-surface-hover focus-visible:outline-none'
const TIME: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' }

/**
 * The popover follows the system's light or dark look (what the window's native material shows),
 * never the app's theme override or a terminal theme's colors: those painted dark text tokens on a
 * light material. `prefers-color-scheme` here is `nativeTheme.shouldUseDarkColors`. The app-wide
 * appearance hook keeps writing <html>, so this puts the system look back whenever it does.
 */
function useSystemAppearance(): void {
  useEffect(() => {
    const root = document.documentElement
    const media = matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const theme = media.matches ? 'dark' : 'light'
      if (root.dataset['theme'] !== theme) root.dataset['theme'] = theme
      for (const name of APP_TOKEN_NAMES) if (root.style.getPropertyValue(name)) root.style.removeProperty(name)
    }
    apply()
    const observer = new MutationObserver(apply)
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme', 'style'] })
    media.addEventListener('change', apply)
    return () => {
      observer.disconnect()
      media.removeEventListener('change', apply)
    }
  }, [])
}

interface ActiveProfile {
  name: string | null
  quietHours: { startHour: number; endHour: number } | null
}

/** The active profile's name (the header's subtitle) and quiet hours (the bell's sub-view). */
function useActiveProfile(): ActiveProfile {
  const [profile, setProfile] = useState<ActiveProfile>({ name: null, quietHours: null })
  useEffect(() => {
    let alive = true
    const read = () =>
      void window.hub.config
        .get()
        .then(({ config }) => {
          if (!alive) return
          const p = config.profiles.find((x) => x.id === config.activeProfileId)
          setProfile({ name: p?.name ?? null, quietHours: p?.alerts?.quietHours ?? null })
        })
        .catch(() => undefined)
    read()
    const off = window.hub.config.onChanged(read)
    return () => {
      alive = false
      off()
    }
  }, [])
  return profile
}

function Dot({ tone, className }: { tone: TrayTone; className?: string }) {
  return <span aria-hidden className={cn('size-2 shrink-0 rounded-full', DOT_CLASS[tone], className)} />
}

/** A block of rows under a small uppercase title; `line` draws the thin separator above it. */
function Section({ title, line, action, children, sectionRef }: { title: string; line?: boolean; action?: ReactNode; children?: ReactNode; sectionRef?: RefObject<HTMLElement | null> }) {
  return (
    <section ref={sectionRef} className={cn('px-2', line ? 'mt-1.5 border-t border-border/60 pt-1.5' : 'pt-1')}>
      <div className="flex h-6 items-center justify-between gap-1 px-2">
        <h2 className="truncate text-2xs font-semibold uppercase tracking-wide text-muted">{title}</h2>
        {action && <span className="flex shrink-0 items-center gap-0.5">{action}</span>}
      </div>
      {children}
    </section>
  )
}

/** A row of "Today": icon or dot · text (with an optional small second line) · value on the right. */
function InfoRow({ icon, title, detail, value, onClick, testId }: { icon: ReactNode; title: string; detail?: string; value?: ReactNode; onClick: () => void; testId: string }) {
  return (
    <button type="button" data-nav data-row={testId} className={cn(ROW, detail && ROW_TWO_LINES)} onClick={onClick}>
      <span aria-hidden className="flex size-5 shrink-0 items-center justify-center text-muted">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate">{title}</span>
        {detail && <span className="block truncate text-2xs leading-3.5 text-muted">{detail}</span>}
      </span>
      {value}
    </button>
  )
}

/** A meeting: its time, where (the call service or the room) and, when close, how soon; "Join" when it starts within 15 min and has a call link. */
function MeetingRow({ m, now }: { m: TrayPopoverMeeting; now: number }) {
  const { t, formatDate } = useI18n()
  const until = countdown(m.startsAt, now)
  const untilText = t(until.key, until.params)
  const detail = [formatDate(m.startsAt, TIME), m.provider ?? m.location, m.soon && !m.ongoing ? t('trayPopover.startsIn', { time: untilText }) : null].filter(Boolean).join(' · ')
  const joinable = m.soon && m.hasJoinUrl
  return (
    <InfoRow
      testId="meeting"
      icon={m.hasJoinUrl ? <Video className="size-3.5" /> : <CalendarDays className="size-3.5" />}
      title={m.title || t('plan.untitled')}
      detail={detail}
      value={joinable ? <Badge tone="warning">{t('trayPopover.join')}</Badge> : <span className={VALUE}>{m.ongoing ? t('trayPopover.now') : untilText}</span>}
      onClick={() => perform({ kind: 'openMeeting', id: m.id })}
    />
  )
}

function TodayRows({ view, now }: { view: TrayPopoverView; now: number }) {
  const { t } = useI18n()
  const { today } = view
  const { pullRequests, health, slack } = today
  return (
    <>
      {today.meetings.map((m) => (
        <MeetingRow key={m.id} m={m} now={now} />
      ))}
      {today.plan.map((i) => (
        <InfoRow
          key={i.id}
          testId="plan"
          icon={<ListTodo className="size-3.5" />}
          title={i.title || t('plan.untitled')}
          detail={t(i.overdue ? 'trayPopover.planOverdue' : 'trayPopover.planDue')}
          value={<span className={cn(VALUE, i.overdue ? 'text-danger' : 'text-warning')}>{t(i.overdue ? 'trayPopover.overdue' : 'trayPopover.dueToday')}</span>}
          onClick={() => go('plan')}
        />
      ))}
      <MoreRow view={view} list="plan" />
      {pullRequests && (
        <InfoRow
          testId="pullRequests"
          icon={<GitPullRequest className="size-3.5" />}
          title={t('trayPopover.pullRequests')}
          value={<span className={VALUE}>{t('trayPopover.prSummary', { toReview: pullRequests.toReview, mine: pullRequests.mine })}</span>}
          onClick={() => go('pullRequests')}
        />
      )}
      {health && (
        <InfoRow
          testId="health"
          icon={<Dot tone={health.tone} />}
          title={health.degraded.length ? t('trayPopover.healthRow', { where: health.degraded.join(', ') }) : t('trayPopover.health')}
          value={<span className={cn(VALUE, TONE_TEXT[health.tone])}>{t(`tray.health.${health.state}` as MessageKey)}</span>}
          onClick={() => go('health')}
        />
      )}
      {slack && (
        <InfoRow
          testId="slack"
          icon={<Dot tone={slack.tone} />}
          title={t('trayPopover.slackFailing')}
          detail={slack.error}
          value={<span className={cn(VALUE, TONE_TEXT[slack.tone])}>{t('tray.slack.failing')}</span>}
          onClick={() => go('slack')}
        />
      )}
    </>
  )
}

function UsageBar({ u, width = 'w-[110px]' }: { u: TrayPopoverUsage; width?: string }) {
  const { formatNumber } = useI18n()
  const { window: w } = u
  return (
    <>
      <span className={cn('h-1.5 shrink-0 overflow-hidden rounded-full bg-text/10', width)} role="progressbar" aria-label={u.name} aria-valuemin={0} aria-valuemax={100} aria-valuenow={w.percent}>
        <span className={cn('block h-full rounded-full', BAR_CLASS[w.tone])} style={{ width: `${Math.max(2, w.percent)}%` }} />
      </span>
      <span className="w-10 shrink-0 text-right text-xs tabular-nums text-text">{formatNumber(w.percent / 100, { style: 'percent' })}</span>
    </>
  )
}

/** One account: name · bar · percent of its most spent window; a click opens Settings → Usage. */
function UsageRow({ u }: { u: TrayPopoverUsage }) {
  const { t } = useI18n()
  return (
    <button
      type="button"
      data-nav
      data-row="usage"
      className={ROW}
      title={t('trayPopover.usageRowTitle', { window: usageWindowName(u.window.window, t), percent: u.window.percent })}
      onClick={() => perform({ kind: 'openSettings', section: 'usage' })}
    >
      <AgentMark agentId={u.agentId} />
      <span className="min-w-0 flex-1 truncate">{u.name}</span>
      <UsageBar u={u} />
    </button>
  )
}

/** "Usage": the rows themselves with 1 to 3 accounts; with more, one summary row that unfolds in place. */
function UsageSection({ usage, line }: { usage: readonly TrayPopoverUsage[]; line: boolean }) {
  const { t } = useI18n()
  const expanded = usePrefs().trayPopoverUsageExpanded
  const { summary, rows } = usageBlock(usage, expanded)
  return (
    <Section title={t('trayPopover.usage')} line={line}>
      {summary && (
        <button
          type="button"
          data-nav
          data-row="usageSummary"
          aria-expanded={expanded}
          title={t(expanded ? 'trayPopover.usageHideAll' : 'trayPopover.usageShowAll')}
          className={ROW}
          onClick={() => setPrefs({ trayPopoverUsageExpanded: !expanded })}
        >
          <AgentMark agentId={summary.top.agentId} />
          <span className="min-w-0 flex-1 truncate">{t('trayPopover.usageSummary', { count: summary.count, name: summary.top.name })}</span>
          <UsageBar u={summary.top} width="w-[64px]" />
          {expanded ? <ChevronDown className="size-3.5 shrink-0 text-muted" aria-hidden /> : <ChevronRight className="size-3.5 shrink-0 text-muted" aria-hidden />}
        </button>
      )}
      {rows.map((u, i) => (
        <UsageRow key={`${u.agentId ?? ''}:${u.name}:${i}`} u={u} />
      ))}
    </Section>
  )
}

function AgentMark({ agentId }: { agentId?: string }) {
  return agentId ? <AgentIcon agentId={agentId} /> : <span aria-hidden className="size-5 shrink-0" />
}

function Age({ at, now }: { at?: number; now: number }) {
  const { t } = useI18n()
  if (at === undefined) return null
  const ago = elapsed(at, now)
  return <span className="w-8 shrink-0 text-right text-2xs tabular-nums text-muted">{ago ?? t('trayPopover.now')}</span>
}

/** A session in "Needs you" (with its state chip) or "Working" (no chip: the section says it). */
function SessionRow({ s, now, chip }: { s: TrayPopoverSession; now: number; chip: boolean }) {
  const { t } = useI18n()
  const c = sessionChip(s)
  return (
    <button type="button" data-nav className={ROW} onClick={() => perform({ kind: 'openSession', id: s.id })}>
      <AgentMark agentId={s.agentId} />
      <span className="min-w-0 flex-1 truncate">{s.title}</span>
      {chip && <Badge tone={c.tone}>{t(c.key)}</Badge>}
      <Age at={s.since} now={now} />
    </button>
  )
}

/** "N more in the app ›": what a list holds past its quota, opened in the main window. */
function MoreRow({ view, list }: { view: TrayPopoverView; list: OverflowList }) {
  const { tn } = useI18n()
  const more = overflowRow(view, list)
  if (!more) return null
  return (
    <button type="button" data-nav data-row={`more-${list}`} className={cn(ROW, 'text-xs text-muted')} onClick={() => perform(more.action)}>
      <span aria-hidden className="size-5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{tn('trayPopover.moreInApp', more.count)}</span>
      <ChevronRight className="size-3.5 shrink-0" aria-hidden />
    </button>
  )
}

/** "Recent · N", folded or unfolded in place (remembered); unfolding brings its title into view. */
function RecentSection({ view, now, line }: { view: TrayPopoverView; now: number; line: boolean }) {
  const { t } = useI18n()
  const memory = usePrefs().trayPopoverRecent
  const expanded = recentExpanded(view, memory)
  const ref = useRef<HTMLElement | null>(null)
  const reveal = useRef(false)
  useLayoutEffect(() => {
    if (!reveal.current || !expanded) return
    reveal.current = false
    ref.current?.scrollIntoView({ block: 'start' })
  }, [expanded])
  const toggle = () => {
    reveal.current = !expanded
    setPrefs({ trayPopoverRecent: { ...memory, [recentContext(view)]: !expanded } })
  }
  const total = view.notifications.length + view.notificationsMore
  return (
    <Section
      sectionRef={ref}
      title={t('trayPopover.recentCount', { count: total })}
      line={line}
      action={
        <>
          <button type="button" data-nav data-testid="tray-popover-recent-toggle" aria-expanded={expanded} className={SMALL_BUTTON} onClick={toggle}>
            {expanded ? <ChevronDown className="size-3" aria-hidden /> : <ChevronRight className="size-3" aria-hidden />}
            {t(expanded ? 'trayPopover.hide' : 'trayPopover.show')}
          </button>
          <button type="button" data-nav className={SMALL_BUTTON} onClick={() => perform({ kind: 'clearNotifications' })}>
            {t('trayPopover.clear')}
          </button>
        </>
      }
    >
      {expanded && (
        <>
          {view.notifications.map((n) => (
            <button key={n.id} type="button" data-nav className={ROW} onClick={() => perform({ kind: 'openNotification', id: n.id })}>
              <span aria-hidden className="flex size-5 shrink-0 items-center justify-center">
                <span className="size-1.5 rounded-full bg-accent" />
              </span>
              <span className="min-w-0 flex-1 truncate">{n.title}</span>
              <Age at={n.at} now={now} />
            </button>
          ))}
          <MoreRow view={view} list="recent" />
        </>
      )}
    </Section>
  )
}

/** No open sessions: one block fills what is left of the middle (never an illustration). */
function EmptyBlock({ profileName, line }: { profileName: string | null; line: boolean }) {
  const { t } = useI18n()
  return (
    <section data-testid="tray-popover-empty" className={cn('mx-2 flex flex-1 flex-col items-center justify-center gap-1 px-6 py-4 text-center', line && 'mt-1.5 border-t border-border/60')}>
      <h2 className="text-sm font-semibold text-text">{t('trayPopover.empty.title')}</h2>
      <p className="text-xs text-muted">{t('trayPopover.empty.body')}</p>
      <button
        type="button"
        data-nav
        className="mt-2 inline-flex h-7 max-w-full items-center gap-1.5 rounded-md px-2 text-xs font-medium text-accent transition-colors hover:bg-accent-soft focus-visible:bg-accent-soft focus-visible:outline-none"
        onClick={() => perform({ kind: 'newSession' })}
      >
        <Plus className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate">{profileName ? t('trayPopover.empty.newSessionIn', { profile: profileName }) : t('trayPopover.newSession')}</span>
      </button>
    </section>
  )
}

/** The main view of the middle, in the order Today · Usage · Needs you · Working · Recent. */
function MainView({ view, profileName }: { view: TrayPopoverView; profileName: string | null }) {
  const { t } = useI18n()
  const now = Date.now()
  // The thin line goes between blocks: above every block but the first one drawn.
  let first = true
  const line = () => {
    const l = !first
    first = false
    return l
  }
  return (
    <>
      {hasToday(view.today) && (
        <Section title={t('trayPopover.todayTitle')} line={line()}>
          <TodayRows view={view} now={now} />
        </Section>
      )}
      {view.usage.length > 0 && <UsageSection usage={view.usage} line={line()} />}
      {view.needsYou.length > 0 && (
        <Section title={t('trayPopover.needsYouTitle')} line={line()}>
          {view.needsYou.map((s) => (
            <SessionRow key={s.id} s={s} now={now} chip />
          ))}
          <MoreRow view={view} list="needsYou" />
        </Section>
      )}
      {view.working.length > 0 && (
        <Section title={t('trayPopover.workingTitle')} line={line()}>
          {view.working.map((s) => (
            <SessionRow key={s.id} s={s} now={now} chip={false} />
          ))}
          <MoreRow view={view} list="working" />
        </Section>
      )}
      {view.notifications.length > 0 && <RecentSection view={view} now={now} line={line()} />}
      {view.summary.open === 0 && <EmptyBlock profileName={profileName} line={line()} />}
    </>
  )
}

const MENU_ICON: Partial<Record<PopoverMenuItem['id'], ReactNode>> = {
  checkForUpdates: <Download className="size-3.5" aria-hidden />,
  quit: <Power className="size-3.5" aria-hidden />
}

/** A footer menu (the bell or "⋯") as a sub-view in place of the middle: "‹ Back" and its title, then its entries. */
function SubView({ menu, view, quietHours, onBack }: { menu: PopoverMenuId; view: TrayPopoverView; quietHours: ActiveProfile['quietHours']; onBack: () => void }) {
  const { t, formatDate } = useI18n()
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role=menuitem]')?.focus({ preventScroll: true })
  }, [menu])
  const title = t(menu === 'notifications' ? 'trayPopover.notificationsMenu' : 'trayPopover.moreTitle')
  const now = new Date()
  const quiet = quietHoursValue(quietHours)
  const valueOf = (item: PopoverMenuItem): string | null => {
    if (item.until) return t('trayPopover.until', { time: formatDate(pauseUntil(item.until, now), TIME) })
    if (item.id === 'quietHours') return t(quiet.key, quiet.params)
    if (item.id === 'adjustNotifications') return t('trayPopover.menu.adjustHint')
    return null
  }
  return (
    <div ref={ref} className="px-2 pt-1">
      <div className="flex h-8 items-center gap-1">
        <button type="button" data-nav data-testid="tray-popover-back" className={cn(SMALL_BUTTON, 'h-7 text-sm')} onClick={onBack}>
          <ChevronLeft className="size-4" aria-hidden />
          {t('trayPopover.back')}
        </button>
        <h2 className="min-w-0 flex-1 truncate px-1 text-sm font-semibold text-text">{title}</h2>
      </div>
      <div role="menu" id="tray-popover-menu" aria-label={title} data-testid="tray-popover-menu" className="flex flex-col pt-1">
        {popoverMenuItems(menu, view).map((item) => {
          const value = valueOf(item)
          return (
            <Fragment key={item.id}>
              {item.separated && <div role="separator" className="mx-2 my-1 h-px bg-border/70" />}
              <button
                type="button"
                role="menuitem"
                data-nav
                data-menu-item={item.id}
                className={cn(ROW, ROW_TWO_LINES, item.id === 'quit' && 'hover:text-danger focus-visible:text-danger')}
                onClick={() => {
                  onBack()
                  perform(item.action)
                }}
              >
                {MENU_ICON[item.id]}
                <span className="min-w-0 flex-1 truncate">{t(item.label, { app: view.appName })}</span>
                {value && <span className={cn(VALUE, 'max-w-[55%] truncate')}>{value}</span>}
                {item.opens && <ChevronRight className="size-3.5 shrink-0 text-muted" aria-hidden />}
              </button>
            </Fragment>
          )
        })}
      </div>
    </div>
  )
}

interface ScrollState {
  top: boolean
  bottom: boolean
  /** The overlay thumb, in px of the visible height; null when nothing overflows. */
  thumb: { top: number; height: number } | null
}

const sameScroll = (a: ScrollState, b: ScrollState) => a.top === b.top && a.bottom === b.bottom && a.thumb?.top === b.thumb?.top && a.thumb?.height === b.thumb?.height

/**
 * The middle: the only zone that scrolls. A thin overlay thumb (it takes no width) and a 28 px
 * fade at the bottom, and at the top once scrolled, say there is more.
 */
function ScrollArea({ scrollRef, children }: { scrollRef: RefObject<HTMLDivElement | null>; children: ReactNode }) {
  const [state, setState] = useState<ScrollState>({ top: false, bottom: false, thumb: null })
  const measure = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const { scrollTop, scrollHeight, clientHeight } = el
    const room = scrollHeight - clientHeight
    const height = room > 1 ? Math.max(24, Math.round((clientHeight * clientHeight) / scrollHeight)) : 0
    const next: ScrollState = {
      top: scrollTop > 1,
      bottom: room > 1 && scrollTop < room - 1,
      thumb: room > 1 ? { height, top: Math.round((scrollTop / room) * (clientHeight - height)) } : null
    }
    setState((prev) => (sameScroll(prev, next) ? prev : next))
  }, [scrollRef])
  // Every render can change the content's height (a new view, an expander): measure again.
  useLayoutEffect(measure)
  return (
    <div className="relative min-h-0">
      <div ref={scrollRef} data-testid="tray-popover-scroll" onScroll={measure} className="no-scrollbar h-full overflow-y-auto overscroll-contain">
        <div className="flex min-h-full flex-col pb-2">{children}</div>
      </div>
      {state.top && <div aria-hidden data-testid="tray-popover-fade-top" className="pointer-events-none absolute inset-x-0 top-0 h-7 bg-linear-to-b from-text/10 to-transparent" />}
      {state.bottom && <div aria-hidden data-testid="tray-popover-fade-bottom" className="pointer-events-none absolute inset-x-0 bottom-0 h-7 bg-linear-to-t from-text/10 to-transparent" />}
      {state.thumb && <div aria-hidden className="pointer-events-none absolute right-0.5 w-1 rounded-full bg-text/25" style={{ top: state.thumb.top, height: state.thumb.height }} />}
    </div>
  )
}

function Header({ view, profileName }: { view: TrayPopoverView | null; profileName: string | null }) {
  const { t, tn, formatDate } = useI18n()
  if (!view) return <header />
  const { verdict } = view
  const title =
    verdict.kind === 'needsYou'
      ? tn('trayPopover.needsYou', verdict.count)
      : verdict.kind === 'working'
        ? tn('trayPopover.working', verdict.count)
        : verdict.kind === 'caughtUp'
          ? t('trayPopover.allCaughtUp')
          : t('trayPopover.noSessions')
  const paused = view.pausedUntil !== null
  const pausedTime = view.pausedUntil && !view.pausedIndefinitely ? formatDate(view.pausedUntil, TIME) : null
  // With no sessions the title already says so: the count would repeat it.
  const subtitle = [profileName, view.summary.open > 0 ? tn('trayPopover.openSessions', view.summary.open) : null].filter(Boolean).join(' · ')
  return (
    <header className="flex h-12 items-center gap-1 px-2">
      <button
        type="button"
        data-nav
        data-testid="tray-popover-open"
        title={t('trayPopover.openTitle', { app: view.appName })}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-md px-2 py-1 text-left transition-colors hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none"
        onClick={() => perform({ kind: 'open' })}
      >
        <Dot tone={verdict.tone} className="size-2.5" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-semibold leading-tight text-text" data-testid="tray-popover-verdict">
            {title}
          </span>
          {(subtitle || paused) && (
            <span className="flex min-w-0 items-center gap-1 truncate pt-0.5 text-xs leading-4 text-muted">
              {subtitle && <span className="truncate">{subtitle}</span>}
              {paused && (
                <span className="inline-flex shrink-0 items-center gap-0.5 text-warning" data-testid="tray-popover-paused">
                  {subtitle && <span aria-hidden>·</span>}
                  <BellOff className="size-3" aria-hidden />
                  {view.pausedIndefinitely ? t('trayPopover.pausedIndefinitelyShort') : t('trayPopover.pausedShort', { time: pausedTime ?? '' })}
                </span>
              )}
            </span>
          )}
        </span>
      </button>
      <button type="button" data-nav data-testid="tray-popover-close" title={t('trayPopover.close')} aria-label={t('trayPopover.close')} className={ICON_BUTTON} onClick={() => window.hub.tray.popover.hide()}>
        <X className="size-4" aria-hidden />
      </button>
    </header>
  )
}

function Footer({ view, menu, onMenu }: { view: TrayPopoverView | null; menu: PopoverMenuId | null; onMenu: (id: PopoverMenuId) => void }) {
  const { t } = useI18n()
  const paused = view?.pausedUntil != null
  const bellLabel = paused ? t('trayPopover.notificationsPausedTitle') : t('trayPopover.notificationsMenu')
  return (
    <footer className="flex h-11 items-center gap-1 border-t border-border/70 px-2">
      <button
        type="button"
        data-nav
        className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium whitespace-nowrap text-accent transition-colors hover:bg-accent-soft focus-visible:bg-accent-soft focus-visible:outline-none"
        onClick={() => perform({ kind: 'newSession' })}
      >
        <Plus className="size-3.5" aria-hidden />
        {t('trayPopover.newSession')}
      </button>
      <span className="flex-1" />
      <button
        type="button"
        data-nav
        data-testid="tray-popover-bell"
        title={bellLabel}
        aria-label={bellLabel}
        aria-haspopup="menu"
        aria-expanded={menu === 'notifications'}
        aria-controls={menu === 'notifications' ? 'tray-popover-menu' : undefined}
        className={cn(ICON_BUTTON, menu === 'notifications' && 'bg-surface-hover text-text', paused && 'text-warning hover:text-warning')}
        onClick={() => onMenu('notifications')}
      >
        {paused ? <BellOff className="size-4" aria-hidden /> : <Bell className="size-4" aria-hidden />}
      </button>
      <button type="button" data-nav title={t('trayPopover.settings')} aria-label={t('trayPopover.settings')} className={ICON_BUTTON} onClick={() => go('settings')}>
        <Settings className="size-4" aria-hidden />
      </button>
      <button
        type="button"
        data-nav
        data-testid="tray-popover-more"
        aria-label={t('trayPopover.moreOptions')}
        aria-haspopup="menu"
        aria-expanded={menu === 'more'}
        aria-controls={menu === 'more' ? 'tray-popover-menu' : undefined}
        title={t('trayPopover.moreOptions')}
        className={cn(ICON_BUTTON, menu === 'more' && 'bg-surface-hover text-text')}
        onClick={() => onMenu('more')}
      >
        <MoreHorizontal className="size-4" aria-hidden />
      </button>
    </footer>
  )
}

/**
 * The fixed 360x520 panel: a 48 px header, the scrolling middle and a 44 px footer. The window
 * never changes size; the bell and "⋯" open sub-views in place of the middle.
 */
function Frame() {
  const { t } = useI18n()
  useSystemAppearance()
  const platform = usePlatform()
  const profile = useActiveProfile()
  const [view, setView] = useState<TrayPopoverView | null>(null)
  const [menu, setMenu] = useState<PopoverMenuId | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  /** Where the main view was scrolled when a sub-view opened: "‹ Back" returns there. */
  const mainScroll = useRef(0)
  const menuRef = useRef(menu)
  menuRef.current = menu

  useEffect(() => {
    let alive = true
    void window.hub.tray.popover.get().then((v) => alive && v && setView(v))
    const offView = window.hub.tray.popover.onView(setView)
    // Each opening starts on the main view, at the top, with nothing focused.
    const offShown = window.hub.tray.popover.onShown(() => {
      mainScroll.current = 0
      setMenu(null)
      scrollRef.current?.scrollTo({ top: 0 })
      ;(document.activeElement as HTMLElement | null)?.blur()
    })
    return () => {
      alive = false
      offView()
      offShown()
    }
  }, [])

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = menu ? 0 : mainScroll.current
  }, [menu])

  const toggleMenu = useCallback((id: PopoverMenuId) => {
    if (menuRef.current === null) mainScroll.current = scrollRef.current?.scrollTop ?? 0
    setMenu((m) => (m === id ? null : id))
  }, [])
  const back = useCallback(() => setMenu(null), [])

  // Escape leaves a sub-view, else closes the popover; the arrow keys move between rows and buttons.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (menuRef.current) return setMenu(null)
        return window.hub.tray.popover.hide()
      }
      const items = [...(rootRef.current?.querySelectorAll<HTMLElement>('[data-nav]') ?? [])]
      const next = nextFocus(items.indexOf(document.activeElement as HTMLElement), items.length, e.key)
      if (next === null) return
      e.preventDefault()
      const item = items[next]
      item?.focus({ preventScroll: true })
      item?.scrollIntoView({ block: 'nearest' })
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label={t('trayPopover.label', { app: view?.appName ?? 'Workhub' })}
      // macOS paints the native popover material behind a transparent page (system corners);
      // Windows and Linux paint a solid panel with a 1 px border and square corners.
      className={cn('grid h-screen grid-cols-[minmax(0,1fr)] grid-rows-[48px_minmax(0,1fr)_44px] overflow-hidden', platform === 'mac' ? 'bg-transparent' : 'border border-border bg-[#f3f4f6] dark:bg-[#171a20]')}
    >
      <Header view={view} profileName={profile.name} />
      <ScrollArea scrollRef={scrollRef}>
        {view && (menu ? <SubView menu={menu} view={view} quietHours={profile.quietHours} onBack={back} /> : <MainView view={view} profileName={profile.name} />)}
      </ScrollArea>
      <Footer view={view} menu={menu} onMenu={toggleMenu} />
    </div>
  )
}

/** The window a click on the menu bar / notification area icon opens (`#tray-popover`). */
export function TrayPopover() {
  useEffect(() => {
    document.title = 'Workhub'
    // A transparent page lets the window's native material show through on macOS.
    document.documentElement.style.background = 'transparent'
    document.body.style.background = 'transparent'
  }, [])
  return (
    <I18nProvider>
      <Frame />
    </I18nProvider>
  )
}
