import { CalendarDays, Flag, Inbox, Users, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import type { Profile } from '@workhub/core'
import type { PlanView } from '@shared/plan-api'
import type { MessageKey } from '../../i18n/translate'
import { InboxTab } from './InboxTab'
import { MilestonesTab } from './MilestonesTab'
import { PeopleTab } from './PeopleTab'
import { TodayTab } from './TodayTab'

/** What every Plan tab gets from the screen. */
export interface PlanTabContext {
  profile: Profile
  view: PlanView
  now: number
  /** The key of the brief action running (`event:<id>` or `person:<id>`), so its button shows it. */
  busy: string | null
  /** Starts the brief of an event, or opens it when it was started. */
  brief: (eventId: string) => void
  /** "Prepare 1:1" for a person. */
  oneOnOne: (personId: string) => void
  /** Opens a link the way the profile opens links (a call link). */
  openLink: (url: string) => void
  openSettings: (tab?: string) => void
}

/**
 * One tab of the Plan screen. Adding a tab is adding an entry here: its id (kept in the screen's
 * state), its label and icon, and what it renders from the shared context.
 */
export interface PlanTab {
  id: string
  label: MessageKey
  icon: LucideIcon
  /** Shown only once the calendars were read (otherwise the tab says how to add one). */
  needsCalendar?: boolean
  render: (context: PlanTabContext) => ReactNode
}

/** The Plan screen's tabs, in order. */
export const PLAN_TABS: readonly PlanTab[] = [
  { id: 'today', label: 'plan.tab.today', icon: CalendarDays, needsCalendar: true, render: (context) => <TodayTab {...context} /> },
  { id: 'inbox', label: 'planner.tab.inbox', icon: Inbox, render: (context) => <InboxTab {...context} /> },
  { id: 'milestones', label: 'planner.tab.milestones', icon: Flag, render: (context) => <MilestonesTab {...context} /> },
  { id: 'people', label: 'plan.tab.people', icon: Users, render: (context) => <PeopleTab {...context} /> }
]
