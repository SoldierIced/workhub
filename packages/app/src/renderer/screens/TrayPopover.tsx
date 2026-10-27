import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Bell, BellOff, ChevronUp, Download, GitPullRequest, Plus, Power, Settings } from 'lucide-react'
import { automationLine, type TrayAction, type TrayPopoverSession, type TrayPopoverUsageAccount, type TrayPopoverView, type TrayRoute } from '@workhub/core'
import type { MessageKey } from '../i18n/translate'
import { usageWindowName } from '../lib/usage-window'
import { Badge } from '../components/atoms'
import { AgentIcon } from '../components/atoms/AgentIcon'
import { BrandMark } from '../components/organisms/BrandMark'
import { I18nProvider, useI18n } from '../i18n/I18nProvider'
import { cn } from '../lib/cn'
import { usePlatform } from '../lib/platform'
import { BAR_CLASS, DOT_CLASS, elapsed, nextFocus, popoverMenuItems, sessionChip, type PopoverMenuItem } from '../lib/trayPopover'

const perform = (action: TrayAction) => window.hub.tray.popover.perform(action)
const go = (route: TrayRoute) => perform({ kind: 'navigate', route })

const ROW = 'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none'

function ClearAll() {
  const { t } = useI18n()
  return (
    <button
      type="button"
      data-nav
      className="rounded px-1.5 py-0.5 text-xs font-normal normal-case tracking-normal text-muted transition-colors hover:bg-surface-hover hover:text-text"
      onClick={() => perform({ kind: 'clearNotifications' })}
    >
      {t('trayPopover.clearNotifications')}
    </button>
  )
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="px-2 pt-2">
      <div className="flex items-center justify-between px-2 pb-1">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-subtle">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  )
}

function AgentMark({ agentId }: { agentId?: string }) {
  return agentId ? <AgentIcon agentId={agentId} /> : <span aria-hidden className="size-5 shrink-0" />
}

function SessionRow({ s, now }: { s: TrayPopoverSession; now: number }) {
  const { t } = useI18n()
  const chip = sessionChip(s)
  const since = s.since !== undefined ? elapsed(s.since, now) : null
  return (
    <button type="button" data-nav className={ROW} onClick={() => perform({ kind: 'openSession', id: s.id })}>
      <AgentMark agentId={s.agentId} />
      <span className="min-w-0 flex-1 truncate">{s.title}</span>
      <Badge tone={chip.tone}>{t(chip.key)}</Badge>
      {since && <span className="w-7 shrink-0 text-right text-2xs tabular-nums text-subtle">{since}</span>}
    </button>
  )
}

function UsageAccount({ account, now }: { account: TrayPopoverUsageAccount; now: number }) {
  const { t, locale } = useI18n()
  const windowLabel = (w: string) => usageWindowName(w, t)
  return (
    <div className="px-2 py-1">
      <div className="mb-1 flex items-center gap-2 text-sm">
        <AgentMark agentId={account.agentId} />
        <span className="min-w-0 flex-1 truncate">{account.name}</span>
        {account.error && <span className="text-xs text-danger">{t('trayPopover.usageError')}</span>}
        {!account.error && account.windows.length === 0 && <span className="text-xs text-subtle">{t('trayPopover.usageNone')}</span>}
      </div>
      {account.windows.map((w) => (
        <div key={w.window} className="flex items-center gap-2 py-0.5 text-xs">
          <span className="w-12 shrink-0 text-muted">{windowLabel(w.window)}</span>
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-hover" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={w.percent}>
            <div className={cn('h-full rounded-full', BAR_CLASS[w.tone])} style={{ width: `${Math.max(2, w.percent)}%` }} />
          </div>
          <span className="w-9 shrink-0 text-right tabular-nums">{new Intl.NumberFormat(locale).format(w.percent)}%</span>
          <span className="w-24 shrink-0 truncate text-right text-2xs text-subtle">
            {w.resetsAt ? t('trayPopover.resetsIn', { time: elapsed(now - (w.resetsAt - now), now) ?? '<1m' }) : ''}
          </span>
        </div>
      ))}
    </div>
  )
}

function StatusLine({ tone, label, onClick }: { tone: keyof typeof DOT_CLASS; label: string; onClick: () => void }) {
  return (
    <button type="button" data-nav className={ROW} onClick={onClick}>
      <span aria-hidden className={cn('size-2 shrink-0 rounded-full', DOT_CLASS[tone])} />
      <span className="min-w-0 flex-1 truncate text-muted">{label}</span>
    </button>
  )
}

const MENU_ICON: Record<PopoverMenuItem['id'], ReactNode> = {
  pauseHour: <BellOff className="size-3.5" aria-hidden />,
  pauseTomorrow: <BellOff className="size-3.5" aria-hidden />,
  resume: <Bell className="size-3.5" aria-hidden />,
  checkForUpdates: <Download className="size-3.5" aria-hidden />,
  quit: <Power className="size-3.5" aria-hidden />
}

/**
 * The popover's own "More" menu, drawn inside the popover just above the footer (the window grows
 * to fit it): pause presets or resume, check for updates, quit. It replaces the native tray menu.
 */
function PopoverMenu({ view, onClose }: { view: TrayPopoverView; onClose: () => void }) {
  const { t } = useI18n()
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.scrollIntoView({ block: 'nearest' })
    ref.current?.querySelector<HTMLElement>('[role=menuitem]')?.focus()
  }, [])
  return (
    <div
      ref={ref}
      role="menu"
      id="tray-popover-menu"
      aria-label={t('trayPopover.moreOptions')}
      data-testid="tray-popover-menu"
      className="mx-2 mb-1 flex flex-col rounded-md border border-border/70 p-1"
    >
      {popoverMenuItems(view).map((item) => (
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
  const [menuOpen, setMenuOpen] = useState(false)
  // Each opening of the popover starts with the menu closed.
  useEffect(() => window.hub.tray.popover.onShown(() => setMenuOpen(false)), [])
  const now = Date.now()
  const headline =
    view.summary.attention > 0
      ? tn('trayPopover.needsYou', view.summary.attention)
      : view.summary.running > 0
        ? tn('trayPopover.running', view.summary.running)
        : view.summary.open > 0
          ? t('trayPopover.allCaughtUp')
          : t('trayPopover.noSessions')
  const accountLine = view.usage[0]
    ? [view.usage[0].name, ...view.usage[0].windows.slice(0, 2).map((w) => `${windowShort(w.window)} ${w.percent}%`)].join(' · ')
    : null
  const pausedTime = view.pausedUntil ? formatDate(view.pausedUntil, { hour: '2-digit', minute: '2-digit' }) : null
  return (
    <>
      <header className="flex items-center gap-2.5 px-4 pb-2 pt-3.5">
        <BrandMark className="size-7" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-base font-semibold leading-tight">{view.appName}</div>
          <div className="truncate text-xs text-muted">{accountLine ?? headline}</div>
        </div>
        <button
          type="button"
          data-nav
          title={t('trayPopover.openTitle', { app: view.appName })}
          className="h-7 rounded-md bg-accent px-3 text-sm font-medium text-accent-fg transition-colors hover:bg-accent-strong"
          onClick={() => perform({ kind: 'open' })}
        >
          {t('trayPopover.open')}
        </button>
      </header>
      {accountLine && <div className="px-4 pb-1 text-xs text-muted">{headline}</div>}

      <div className="pb-1">
        {view.slack && (
          <div className="px-2">
            <StatusLine
              tone={view.slack.tone}
              label={`${t(`tray.slack.${view.slack.health}` as MessageKey)} · ${tn('tray.slack.threads', view.slack.open)}${view.slack.unread ? ` · ${tn('tray.slack.unread', view.slack.unread)}` : ''}`}
              onClick={() => go('slack')}
            />
            {view.slack.health === 'failing' && view.slack.error && (
              <button type="button" data-nav className={cn(ROW, 'text-warning')} onClick={() => go('slack')}>
                <span className="line-clamp-2">{t('tray.slack.error', { error: view.slack.error })}</span>
              </button>
            )}
          </div>
        )}
        {view.health && (
          <div className="px-2">
            <StatusLine
              tone={view.health.tone}
              label={`${t('tray.section.health')}: ${view.health.state ? t(`tray.health.${view.health.state}` as MessageKey) : t('tray.health.pending')}${view.health.degraded.length ? ` (${view.health.degraded.slice(0, 3).join(', ')})` : ''}`}
              onClick={() => go('health')}
            />
          </div>
        )}

        {view.needsYou.length > 0 && (
          <Section title={t('trayPopover.needsYouTitle')}>
            {view.needsYou.map((s) => (
              <SessionRow key={s.id} s={s} now={now} />
            ))}
            {view.needsYouMore > 0 && <MoreLine count={view.needsYouMore} onClick={() => go('sessions')} />}
          </Section>
        )}
        {(view.sessions.length > 0 || view.needsYou.length === 0) && (
          <Section title={t('trayPopover.sessions')}>
            {view.sessions.length === 0 && <p className="px-2 py-1 text-sm text-muted">{t('trayPopover.noSessions')}</p>}
            {view.sessions.map((s) => (
              <SessionRow key={s.id} s={s} now={now} />
            ))}
            {view.sessionsMore > 0 && <MoreLine count={view.sessionsMore} onClick={() => go('sessions')} />}
          </Section>
        )}

        {view.usage.length > 0 && (
          <Section title={t('trayPopover.usage')}>
            {view.usage.map((a) => (
              <UsageAccount key={a.agentId ?? a.name} account={a} now={now} />
            ))}
          </Section>
        )}

        {view.automations.length > 0 && (
          <Section title={t('trayPopover.automations')}>
            {view.automations.map((a) => (
              <button key={a.id} type="button" data-nav className={cn(ROW, a.health === 'failing' ? 'text-warning' : 'text-muted')} onClick={() => go('automations')}>
                <span aria-hidden className={cn('size-2 shrink-0 rounded-full', DOT_CLASS[a.tone])} />
                <span className="min-w-0 flex-1 truncate">{`${a.name}: ${automationLine(a, (key, params) => t(key as MessageKey, params))}`}</span>
              </button>
            ))}
          </Section>
        )}

        {view.pullRequests && (
          <Section title={t('trayPopover.pullRequests')}>
            <button type="button" data-nav className={ROW} onClick={() => go('pullRequests')}>
              <GitPullRequest className="size-4 text-muted" aria-hidden />
              <span className="flex-1">{t('trayPopover.prToReview')}</span>
              <span className="tabular-nums text-muted">{view.pullRequests.toReview}</span>
            </button>
            <button type="button" data-nav className={ROW} onClick={() => go('pullRequests')}>
              <GitPullRequest className="size-4 text-muted" aria-hidden />
              <span className="flex-1">{t('trayPopover.prMine')}</span>
              <span className="tabular-nums text-muted">{view.pullRequests.mine}</span>
            </button>
            {view.prEvents.map((e) => (
              <button key={e.url} type="button" data-nav className={cn(ROW, 'text-muted')} onClick={() => perform({ kind: 'openPullRequest', profileId: e.profileId, url: e.url })}>
                <span className="truncate">{e.title}</span>
              </button>
            ))}
          </Section>
        )}

        <Section title={t('trayPopover.notifications')} action={view.notifications.length > 0 ? <ClearAll /> : undefined}>
          {view.notifications.length === 0 && <p className="px-2 py-1 text-sm text-muted">{t('trayPopover.noNotifications')}</p>}
          {view.notifications.map((n) => (
            <button key={n.id} type="button" data-nav className={ROW} onClick={() => perform({ kind: 'openNotification', id: n.id })}>
              <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-accent" />
              <span className="min-w-0 flex-1 truncate">{n.title}</span>
              <span className="shrink-0 text-2xs tabular-nums text-subtle">
                {n.at !== undefined ? (elapsed(n.at, now) ? t('trayPopover.timeAgo', { time: elapsed(n.at, now)! }) : t('trayPopover.now')) : ''}
              </span>
            </button>
          ))}
        </Section>
      </div>

      {menuOpen && <PopoverMenu view={view} onClose={() => setMenuOpen(false)} />}
      <footer className="flex items-center gap-1 border-t border-border/70 px-2 py-1.5">
        <FooterButton icon={<Plus className="size-3.5" />} label={t('trayPopover.newSession')} onClick={() => perform({ kind: 'newSession' })} />
        <FooterButton icon={<Settings className="size-3.5" />} label={t('trayPopover.settings')} onClick={() => go('settings')} />
        <span className="flex-1" />
        {view.pausedUntil ? (
          <FooterButton
            icon={<BellOff className="size-3.5" />}
            label={t('trayPopover.resume')}
            title={t('trayPopover.pausedUntil', { time: pausedTime ?? '' })}
            onClick={() => perform({ kind: 'resume' })}
          />
        ) : (
          <FooterButton icon={<Bell className="size-3.5" />} label={t('trayPopover.pause')} onClick={() => perform({ kind: 'pause', preset: 'hour' })} />
        )}
        <button
          type="button"
          data-nav
          data-testid="tray-popover-more"
          aria-label={t('trayPopover.moreOptions')}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-controls={menuOpen ? 'tray-popover-menu' : undefined}
          title={t('trayPopover.moreOptions')}
          className={cn('inline-flex size-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-hover hover:text-text', menuOpen && 'bg-surface-hover text-text')}
          onClick={() => setMenuOpen((o) => !o)}
        >
          <ChevronUp className={cn('size-4 transition-transform', menuOpen && 'rotate-180')} aria-hidden />
        </button>
      </footer>
    </>
  )
}

const windowShort = (w: string) => (w === 'weekly' ? '7d' : w)

function MoreLine({ count, onClick }: { count: number; onClick: () => void }) {
  const { tn } = useI18n()
  return (
    <button type="button" data-nav className={cn(ROW, 'text-xs text-muted')} onClick={onClick}>
      {tn('trayPopover.more', count)}
    </button>
  )
}

function FooterButton({ icon, label, title, onClick }: { icon: ReactNode; label: string; title?: string; onClick: () => void }) {
  return (
    <button
      type="button"
      data-nav
      title={title}
      className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted transition-colors hover:bg-surface-hover hover:text-text"
      onClick={onClick}
    >
      {icon}
      {label}
    </button>
  )
}

function Frame() {
  const { t } = useI18n()
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
