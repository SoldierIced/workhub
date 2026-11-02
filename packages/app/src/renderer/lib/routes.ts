import { Activity, Bot, CalendarDays, GitPullRequest, Hash, History, House, Route as RouteIcon, Settings, SquareTerminal, Ticket, type LucideIcon } from 'lucide-react'
import type { MessageKey } from '../i18n/translate'
import type { Route } from './nav'

export const ROUTE_LABEL: Record<Route, MessageKey> = {
  home: 'nav.home',
  pullRequests: 'nav.pullRequests',
  tickets: 'nav.tickets',
  slack: 'nav.slack',
  automations: 'nav.automations',
  history: 'nav.history',
  flowMaps: 'nav.flowMaps',
  health: 'nav.health',
  plan: 'nav.plan',
  sessions: 'nav.sessions',
  settings: 'nav.settings'
}

export const ROUTE_ICON: Record<Route, LucideIcon> = {
  home: House,
  pullRequests: GitPullRequest,
  tickets: Ticket,
  slack: Hash,
  automations: Bot,
  history: History,
  flowMaps: RouteIcon,
  health: Activity,
  plan: CalendarDays,
  sessions: SquareTerminal,
  settings: Settings
}
