import { Activity, Bot, GitPullRequest, Hash, History, House, Settings, SquareTerminal, Ticket, Workflow, type LucideIcon } from 'lucide-react'
import type { MessageKey } from '../i18n/translate'
import type { Route } from './nav'

export const ROUTE_LABEL: Record<Route, MessageKey> = {
  home: 'nav.home',
  pullRequests: 'nav.pullRequests',
  tickets: 'nav.tickets',
  slack: 'nav.slack',
  automations: 'nav.automations',
  history: 'nav.history',
  flows: 'nav.flows',
  health: 'nav.health',
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
  flows: Workflow,
  health: Activity,
  sessions: SquareTerminal,
  settings: Settings
}
