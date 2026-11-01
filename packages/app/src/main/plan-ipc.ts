/**
 * The Plan bridge: the agenda of a profile, the calendar connection test, briefs, and the words of
 * a meeting reminder.
 */
import type { Connection, DueAction, SecretChange, TrayText } from '@workhub/core'
import type { BriefResult, CalendarTestResult, PlanView } from '../shared/plan-api'
import type { CalendarService } from './calendar-service'
import type { IpcRegistrar } from './ipc-guard'
import type { BriefService } from './plan-briefs'

export interface PlanIpcDeps {
  calendar: CalendarService
  briefs: BriefService
}

/** The agenda of a profile with its briefs. */
export async function planView(deps: PlanIpcDeps, profileId: string | null, force = false): Promise<PlanView> {
  const view = await deps.calendar.view(profileId, force)
  const profile = await deps.calendar.profileOf(profileId)
  return { ...view, briefs: profile ? deps.briefs.views(profile.id) : {} }
}

const isSecretChange = (s: unknown): s is SecretChange => {
  const action = (s as { action?: unknown } | null)?.action
  return action === 'keep' || action === 'clear' || (action === 'set' && typeof (s as { value?: unknown }).value === 'string')
}

export function registerPlanIpc(ipc: IpcRegistrar, deps: PlanIpcDeps): void {
  ipc.handle('plan:get', (_e, profileId: unknown, force?: unknown) => planView(deps, typeof profileId === 'string' ? profileId : null, force === true))
  ipc.handle('plan:test', async (_e, connection: Connection, secret: unknown): Promise<CalendarTestResult> => {
    if (!connection || typeof connection !== 'object' || connection.kind !== 'calendar' || typeof connection.id !== 'string' || !isSecretChange(secret)) return { ok: false, failure: 'noSecret' }
    return deps.calendar.test({ ...connection, settings: connection.settings && typeof connection.settings === 'object' ? connection.settings : {} }, secret)
  })
  ipc.handle('plan:brief', async (_e, profileId: unknown, eventId: unknown): Promise<BriefResult> => {
    if (typeof profileId !== 'string' || typeof eventId !== 'string') return { ok: false, error: 'bad request' }
    const read = await deps.calendar.read(profileId)
    const event = read?.events.find((e) => e.id === eventId)
    return event ? deps.briefs.brief(profileId, event) : deps.briefs.openById(profileId, eventId)
  })
  ipc.handle('plan:oneOnOne', async (_e, profileId: unknown, personId: unknown): Promise<BriefResult> => {
    if (typeof profileId !== 'string' || typeof personId !== 'string') return { ok: false, error: 'bad request' }
    const read = await deps.calendar.read(profileId)
    return deps.briefs.oneOnOne(profileId, personId, read?.events ?? [])
  })
}

/** The title and body of a meeting reminder, in the tray's language. */
export function meetingReminderWords(action: Pick<DueAction, 'event' | 'message'>, now: number, text: Pick<TrayText, 't' | 'time'>): { title: string; body: string } {
  const { event } = action
  const title = event.title || text.t('plan.untitled')
  const minutes = Math.round((event.start - now) / 60_000)
  const heading = minutes > 0 ? text.t('notify.meeting.soon', { title, minutes }) : text.t('notify.meeting.now', { title })
  const where = event.meetingUrl ? text.t('notify.meeting.call') : event.location
  const body = action.message ?? [text.time(event.start), where].filter(Boolean).join(' · ')
  return { title: heading, body }
}
