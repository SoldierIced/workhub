import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Bell, BellOff, CalendarDays, Download, GitPullRequest, ListTodo, MoreHorizontal, Plus, Power, Settings, Video, X } from 'lucide-react'
import { hasToday, type TrayAction, type TrayPopoverMeeting, type TrayPopoverSession, type TrayPopoverUsage, type TrayPopoverView, type TrayRoute, type TrayTone } from '@workhub/core'
import type { MessageKey } from '../i18n/translate'
import { usageWindowName } from '../lib/usage-window'
import { Badge } from '../components/atoms'
import { AgentIcon } from '../components/atoms/AgentIcon'
import { I18nProvider, useI18n } from '../i18n/I18nProvider'
import { cn } from '../lib/cn'
import { usePlatform } from '../lib/platform'
import { APP_TOKEN_NAMES } from '../lib/terminalThemes'
import { BAR_CLASS, countdown, DOT_CLASS, elapsed, nextFocus, popoverMenuItems, sessionChip, type PopoverMenuId, type PopoverMenuItem } from '../lib/trayPopover'

const perform = (action: TrayAction) => window.hub.tray.popover.perform(action)
const go = (route: TrayRoute) => perform({ kind: 'navigate', route })

/** Every line of the popover: a flat row (no box) of about 28 px on the window's material. */
const ROW = 'flex min-h-7 w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm text-text transition-colors hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none'
const VALUE = 'shrink-0 text-xs tabular-nums text-muted'
const TONE_TEXT: Record<TrayTone, string> = { neutral: 'text-muted', success: 'text-success', info: 'text-info', warning: 'text-warning', danger: 'text-danger' }
const ICON_BUTTON = 'inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-hover hover:text-text focus-visible:bg-surface-hover focus-visible:outline-none'

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

/** The active profile's name, for the header's subtitle. */
function useActiveProfileName(): string | null {
  const [name, setName] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    const read = () =>
      void window.hub.config
        .get()
        .then(({ config }) => alive && setName(config.profiles.find((p) => p.id === config.activeProfileId)?.name ?? null))
        .catch(() => undefined)
    read()
    const off = window.hub.config.onChanged(read)
    return () => {
      alive = false
      off()
    }
  }, [])
  return name
}

function Dot({ tone, className }: { tone: TrayTone; className?: string }) {
  return <span aria-hidden className={cn('size-2 shrink-0 rounded-full', DOT_CLASS[tone], className)} />
}

/** A block of rows under a small uppercase title; `line` draws the thin separator above it. */
function Section({ title, line, action, children }: { title: string; line?: boolean; action?: ReactNode; children: ReactNode }) {
  return (
    <section className={cn('px-2', line ? 'mt-1.5 border-t border-border/60 pt-1.5' : 'pt-1')}>
      <div className="flex h-6 items-center justify-between px-2">
        <h2 className="text-2xs font-semibold uppercase tracking-wide text-muted">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  )
}

/** A row of "Today": icon or dot · text (with an optional small second line) · value on the right. */
function InfoRow({ icon, title, detail, value, onClick, testId }: { icon: ReactNode; title: string; detail?: string; value?: ReactNode; onClick: () => void; testId: string }) {
  return (
    <button type="button" data-nav data-row={testId} className={ROW} onClick={onClick}>
      <span aria-hidden className="flex size-5 shrink-0 items-center justify-center text-muted">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate">{title}</span>
        {detail && <span className="block truncate text-2xs text-muted">{detail}</span>}
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
  const detail = [formatDate(m.startsAt, { hour: '2-digit', minute: '2-digit' }), m.provider ?? m.location, m.soon && !m.ongoing ? t('trayPopover.startsIn', { time: untilText }) : null].filter(Boolean).join(' · ')
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

function TodayRows({ today, now }: { today: TrayPopoverView['today']; now: number }) {
  const { t } = useI18n()
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

/** One account: name · bar · percent of its most spent window; a click opens Settings → Usage. */
function UsageRow({ u }: { u: TrayPopoverUsage }) {
  const { t, formatNumber } = useI18n()
  const { window: w } = u
  return (
    <button
      type="button"
      data-nav
      data-row="usage"
      className={ROW}
      title={t('trayPopover.usageRowTitle', { window: usageWindowName(w.window, t), percent: w.percent })}
      onClick={() => perform({ kind: 'openSettings', section: 'usage' })}
    >
      <AgentMark agentId={u.agentId} />
      <span className="min-w-0 flex-1 truncate">{u.name}</span>
      <span className="h-1.5 w-[110px] shrink-0 overflow-hidden rounded-full bg-text/10" role="progressbar" aria-label={u.name} aria-valuemin={0} aria-valuemax={100} aria-valuenow={w.percent}>
        <span className={cn('block h-full rounded-full', BAR_CLASS[w.tone])} style={{ width: `${Math.max(2, w.percent)}%` }} />
      </span>
      <span className="w-10 shrink-0 text-right text-xs tabular-nums text-text">{formatNumber(w.percent / 100, { style: 'percent' })}</span>
    </button>
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

function MoreRow({ count }: { count: number }) {
  const { tn } = useI18n()
  return (
    <button type="button" data-nav className={cn(ROW, 'text-xs text-muted')} onClick={() => perform({ kind: 'open' })}>
      <span aria-hidden className="size-5 shrink-0" />
      {tn('trayPopover.more', count)}
    </button>
  )
}

const MENU_ICON: Partial<Record<PopoverMenuItem['id'], ReactNode>> = {
  checkForUpdates: <Download className="size-3.5" aria-hidden />,
  quit: <Power className="size-3.5" aria-hidden />
}

/** A footer menu (the bell or "⋯"), drawn inside the popover just above the footer (the window grows to fit it). */
function PopoverMenu({ menu, view, onClose }: { menu: PopoverMenuId; view: TrayPopoverView; onClose: () => void }) {
  const { t } = useI18n()
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.scrollIntoView({ block: 'nearest' })
    ref.current?.querySelector<HTMLElement>('[role=menuitem]')?.focus()
  }, [menu])
  return (
    <div
      ref={ref}
      role="menu"
      id="tray-popover-menu"
      aria-label={t(menu === 'notifications' ? 'trayPopover.notificationsMenu' : 'trayPopover.moreOptions')}
      data-testid="tray-popover-menu"
      className="mx-2 mb-1 flex flex-col rounded-md border border-border/70 p-1"
    >
      {popoverMenuItems(menu, view).map((item) => (
        <Fragment key={item.id}>
          {item.separated && <div role="separator" className="mx-2 my-1 h-px bg-border/70" />}
          <button
            type="button"
            role="menuitem"
            data-nav
            data-menu-item={item.id}
            className={cn(ROW, item.id === 'quit' && 'hover:text-danger focus-visible:text-danger')}
            onClick={() => {
              onClose()
              perform(item.action)
            }}
          >
            {MENU_ICON[item.id]}
            <span className="min-w-0 flex-1 truncate">{t(item.label, { app: view.appName })}</span>
          </button>
        </Fragment>
      ))}
    </div>
  )
}

function Content({ view }: { view: TrayPopoverView }) {
  const { t, tn, formatDate } = useI18n()
  const profileName = useActiveProfileName()
  const [menu, setMenu] = useState<PopoverMenuId | null>(null)
  // Each opening of the popover starts with the menus closed.
  useEffect(() => window.hub.tray.popover.onShown(() => setMenu(null)), [])
  const toggleMenu = (id: PopoverMenuId) => setMenu((m) => (m === id ? null : id))
  const now = Date.now()
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
  const pausedTime = view.pausedUntil && !view.pausedIndefinitely ? formatDate(view.pausedUntil, { hour: '2-digit', minute: '2-digit' }) : null
  // With no sessions the title already says so: the count would repeat it.
  const subtitle = [profileName, view.summary.open > 0 ? tn('trayPopover.openSessions', view.summary.open) : null].filter(Boolean).join(' · ')
  const today = hasToday(view.today)
  const usage = view.usage.length > 0
  // The thin line goes between blocks: above the first session list when "Today" or "Usage" is drawn.
  let sessionsLine = today || usage
  const nextLine = () => {
    const line = sessionsLine
    sessionsLine = false
    return line
  }
  return (
    <>
      <header className="flex items-center gap-1 px-2 pb-1.5 pt-2.5">
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
              <span className="flex min-w-0 items-center gap-1 truncate pt-0.5 text-xs text-muted">
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

      <div className="pb-2">
        {today && (
          <Section title={t('trayPopover.todayTitle')}>
            <TodayRows today={view.today} now={now} />
          </Section>
        )}
        {usage && (
          <Section title={t('trayPopover.usage')} line={today}>
            {view.usage.map((u, i) => (
              <UsageRow key={`${u.agentId ?? ''}:${u.name}:${i}`} u={u} />
            ))}
          </Section>
        )}
        {view.needsYou.length > 0 && (
          <Section title={t('trayPopover.needsYouTitle')} line={nextLine()}>
            {view.needsYou.map((s) => (
              <SessionRow key={s.id} s={s} now={now} chip />
            ))}
            {view.needsYouMore > 0 && <MoreRow count={view.needsYouMore} />}
          </Section>
        )}
        {view.working.length > 0 && (
          <Section title={t('trayPopover.workingTitle')} line={nextLine()}>
            {view.working.map((s) => (
              <SessionRow key={s.id} s={s} now={now} chip={false} />
            ))}
            {view.workingMore > 0 && <MoreRow count={view.workingMore} />}
          </Section>
        )}
        {view.notifications.length > 0 && (
          <Section
            title={t('trayPopover.recent')}
            line={nextLine()}
            action={
              <button
                type="button"
                data-nav
                className="rounded px-1.5 py-0.5 text-xs text-muted transition-colors hover:bg-surface-hover hover:text-text focus-visible:bg-surface-hover focus-visible:outline-none"
                onClick={() => perform({ kind: 'clearNotifications' })}
              >
                {t('trayPopover.clear')}
              </button>
            }
          >
            {view.notifications.map((n) => (
              <button key={n.id} type="button" data-nav className={ROW} onClick={() => perform({ kind: 'openNotification', id: n.id })}>
                <span aria-hidden className="flex size-5 shrink-0 items-center justify-center">
                  <span className="size-1.5 rounded-full bg-accent" />
                </span>
                <span className="min-w-0 flex-1 truncate">{n.title}</span>
                <Age at={n.at} now={now} />
              </button>
            ))}
            {view.notificationsMore > 0 && <MoreRow count={view.notificationsMore} />}
          </Section>
        )}
      </div>

      {menu && <PopoverMenu menu={menu} view={view} onClose={() => setMenu(null)} />}
      <footer className="flex items-center gap-1 border-t border-border/70 px-2 py-1.5">
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
          title={paused ? t('trayPopover.notificationsPausedTitle') : t('trayPopover.notificationsMenu')}
          aria-label={paused ? t('trayPopover.notificationsPausedTitle') : t('trayPopover.notificationsMenu')}
          aria-haspopup="menu"
          aria-expanded={menu === 'notifications'}
          aria-controls={menu === 'notifications' ? 'tray-popover-menu' : undefined}
          className={cn(ICON_BUTTON, menu === 'notifications' && 'bg-surface-hover text-text', paused && 'text-warning hover:text-warning')}
          onClick={() => toggleMenu('notifications')}
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
          onClick={() => toggleMenu('more')}
        >
          <MoreHorizontal className="size-4" aria-hidden />
        </button>
      </footer>
    </>
  )
}

function Frame() {
  const { t } = useI18n()
  useSystemAppearance()
  const platform = usePlatform()
  const [view, setView] = useState<TrayPopoverView | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    void window.hub.tray.popover.get().then((v) => alive && v && setView(v))
    const offView = window.hub.tray.popover.onView(setView)
    const offShown = window.hub.tray.popover.onShown(() => {
      scrollRef.current?.scrollTo({ top: 0 })
      ;(document.activeElement as HTMLElement | null)?.blur()
    })
    return () => {
      alive = false
      offView()
      offShown()
    }
  }, [])

  // The window follows the content's height (the header and footer stay, the middle scrolls).
  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return
    const report = () => {
      const inner = scrollRef.current
      if (!inner) return
      const chrome = el.scrollHeight - inner.clientHeight
      window.hub.tray.popover.resize(Math.ceil(chrome + inner.scrollHeight))
    }
    report()
    const observer = new ResizeObserver(report)
    observer.observe(el)
    if (scrollRef.current?.firstElementChild) observer.observe(scrollRef.current.firstElementChild)
    return () => observer.disconnect()
  }, [view])

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') return window.hub.tray.popover.hide()
    const items = [...(rootRef.current?.querySelectorAll<HTMLElement>('[data-nav]') ?? [])]
    const next = nextFocus(items.indexOf(document.activeElement as HTMLElement), items.length, e.key)
    if (next === null) return
    e.preventDefault()
    items[next]?.focus()
  }, [])

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label={t('trayPopover.label', { app: view?.appName ?? 'Workhub' })}
      onKeyDown={onKeyDown}
      // macOS paints the native popover material behind a transparent page; elsewhere the page is its own card.
      className={cn('flex max-h-screen flex-col overflow-hidden', platform === 'mac' ? 'bg-transparent' : 'rounded-lg border border-border bg-surface shadow-lg')}
    >
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div>{view && <Content view={view} />}</div>
      </div>
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
