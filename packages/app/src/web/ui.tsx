// The phone's building blocks: a screen with a header, the tab bar, rows, and the connection banner.
import { ChevronLeft, Bell, GitPullRequest, MessageSquare, Settings as SettingsIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Spinner } from '../renderer/components/atoms'
import { useI18n } from '../renderer/i18n/I18nProvider'
import { cn } from '../renderer/lib/cn'
import { goBack, navigate, useClientStatus, useRoute } from './app-context'
import type { Route } from './routes'

export function Screen({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex h-full min-h-0 flex-col bg-bg text-text', className)}>{children}</div>
}

export function Header({ title, subtitle, back, right }: { title: ReactNode; subtitle?: ReactNode; back?: boolean | Route; right?: ReactNode }) {
  const { t } = useI18n()
  return (
    <header className="safe-top flex shrink-0 items-center gap-2 border-b border-border bg-sidebar px-2 pb-2">
      <div className="flex min-h-12 w-full items-center gap-2">
        {back ? (
          <button type="button" aria-label={t('web.back')} onClick={() => (back === true ? goBack() : navigate(back))} className="flex size-10 shrink-0 items-center justify-center rounded-lg text-muted active:bg-surface-hover">
            <ChevronLeft className="size-6" aria-hidden />
          </button>
        ) : (
          <span className="w-2" />
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <h1 className="truncate text-lg font-semibold leading-tight">{title}</h1>
          {subtitle && <div className="truncate text-xs text-muted">{subtitle}</div>}
        </div>
        {right}
      </div>
    </header>
  )
}

export function Body({ children, className }: { children: ReactNode; className?: string }) {
  return <main className={cn('scroll-y min-h-0 flex-1', className)}>{children}</main>
}

/** The bottom tabs; tabs the desktop did not grant are left out. */
export function TabBar({ capabilities }: { capabilities: readonly string[] }) {
  const { t } = useI18n()
  const route = useRoute()
  const all: { route: Route; label: string; icon: ReactNode; need?: string }[] = [
    { route: { screen: 'home' }, label: t('web.nav.sessions'), icon: <MessageSquare className="size-5" aria-hidden />, need: 'sessions' },
    { route: { screen: 'pullRequests' }, label: t('web.nav.pullRequests'), icon: <GitPullRequest className="size-5" aria-hidden />, need: 'pullRequests' },
    { route: { screen: 'alerts' }, label: t('web.nav.alerts'), icon: <Bell className="size-5" aria-hidden />, need: 'health' },
    { route: { screen: 'settings' }, label: t('web.nav.settings'), icon: <SettingsIcon className="size-5" aria-hidden /> }
  ]
  const tabs = all.filter((tab) => !tab.need || capabilities.includes(tab.need))
  const active = (r: Route) => r.screen === route.screen || (r.screen === 'home' && (route.screen === 'session' || route.screen === 'new'))
  return (
    <nav className="safe-bottom shrink-0 border-t border-border bg-sidebar" aria-label={t('web.nav.sessions')}>
      <div className="flex h-14 items-stretch">
        {tabs.map((tab) => (
          <button
            key={tab.route.screen}
            type="button"
            onClick={() => navigate(tab.route)}
            aria-current={active(tab.route) ? 'page' : undefined}
            className={cn('flex flex-1 flex-col items-center justify-center gap-0.5 text-2xs font-medium', active(tab.route) ? 'text-accent' : 'text-muted')}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>
    </nav>
  )
}

/** One line under the header when the desktop is not reachable. */
export function ConnectionBanner() {
  const { t } = useI18n()
  const status = useClientStatus()
  const desktop = status.desktop?.name ?? ''
  if (status.state === 'online' || status.state === 'unpaired' || status.state === 'pairing') return null
  const text =
    status.state === 'connecting'
      ? t('web.state.connecting')
      : status.state === 'revoked'
        ? t('web.state.revoked')
        : status.error && status.error !== 'disconnected'
          ? t('web.state.error', { error: status.error })
          : t('web.state.desktopOffline', { desktop })
  return (
    <div role="status" className={cn('flex shrink-0 items-center gap-2 px-4 py-1.5 text-xs', status.state === 'revoked' ? 'bg-danger-soft text-danger' : 'bg-warning-soft text-warning')}>
      {status.state === 'connecting' && <Spinner className="size-3" />}
      <span className="min-w-0 flex-1 truncate">{text}</span>
    </div>
  )
}

export function Row({ children, onClick, className, right }: { children: ReactNode; onClick?: () => void; className?: string; right?: ReactNode }) {
  const Tag = onClick ? 'button' : 'div'
  return (
    <Tag type={onClick ? 'button' : undefined} onClick={onClick} className={cn('flex w-full items-center gap-3 px-4 py-3 text-left', onClick && 'active:bg-surface-hover', className)}>
      <div className="min-w-0 flex-1">{children}</div>
      {right}
    </Tag>
  )
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between px-4 pt-4 pb-1.5">
      <h2 className="text-xs font-semibold tracking-wide text-muted uppercase">{children}</h2>
      {right && <span className="text-2xs text-subtle">{right}</span>}
    </div>
  )
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center gap-1 px-8 py-16 text-center">
      <div className="text-md font-medium text-text">{title}</div>
      {hint && <div className="text-sm text-muted">{hint}</div>}
    </div>
  )
}

export function BigButton({ children, onClick, variant = 'primary', disabled, type = 'button' }: { children: ReactNode; onClick?: () => void; variant?: 'primary' | 'secondary' | 'danger'; disabled?: boolean; type?: 'button' | 'submit' }) {
  const look =
    variant === 'primary' ? 'bg-accent text-accent-fg font-semibold' : variant === 'danger' ? 'border border-danger/40 bg-danger-soft text-danger font-medium' : 'border border-border-strong text-text font-medium'
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={cn('flex h-12 w-full items-center justify-center gap-2 rounded-xl text-md transition-opacity disabled:opacity-45', look)}>
      {children}
    </button>
  )
}

/** A yes/no that replaces its trigger in place: no browser dialog, nothing that blocks the page. */
export function InlineConfirm({ question, yes, onYes, onNo, danger }: { question: string; yes: string; onYes: () => void; onNo: () => void; danger?: boolean }) {
  const { t } = useI18n()
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-sm">
      <span className="min-w-0 flex-1">{question}</span>
      <button type="button" onClick={onNo} className="h-8 rounded-md border border-border-strong px-3 text-sm">
        {t('web.cancel')}
      </button>
      <button type="button" onClick={onYes} className={cn('h-8 rounded-md px-3 text-sm font-semibold', danger ? 'bg-danger text-white' : 'bg-accent text-accent-fg')}>
        {yes}
      </button>
    </div>
  )
}

export function basename(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path
}
