import type { CalendarEvent, MeetingRule, PlannerSettings } from './types'

/** The id of the profile's default reminder (`reminderLeadMinutes`), in fired keys. */
export const DEFAULT_REMINDER_ID = 'default'
/** A reminder or brief whose moment passed while the app was not looking still fires this long after the start. */
export const LATE_GRACE_MS = 2 * 60_000
/** Fired keys are kept this long, so a restart never repeats them. */
export const FIRED_KEEP_MS = 3 * 86_400_000

/** Whether a rule's conditions hold for an event (the rule's switch is checked by the caller). */
export function ruleMatches(rule: Pick<MeetingRule, 'match'>, event: CalendarEvent): boolean {
  const { titleContains, titleRegex, attendeeEmails, minAttendees, recurringOnly } = rule.match
  const title = event.title.toLowerCase()
  const words = (titleContains ?? []).map((w) => w.trim().toLowerCase()).filter(Boolean)
  if (words.length && !words.some((w) => title.includes(w))) return false
  if (titleRegex?.trim()) {
    let pattern: RegExp
    try {
      pattern = new RegExp(titleRegex, 'i')
    } catch {
      return false
    }
    if (!pattern.test(event.title)) return false
  }
  const emails = (attendeeEmails ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean)
  if (emails.length) {
    const present = new Set([...event.attendees.map((a) => a.email), ...(event.organizer ? [event.organizer.email] : [])])
    if (!emails.some((e) => present.has(e))) return false
  }
  if (minAttendees !== undefined && event.attendees.length < minAttendees) return false
  if (recurringOnly && !event.recurring) return false
  return true
}

/** Whether a regular expression typed in a rule compiles. */
export function isValidRuleRegex(source: string): boolean {
  try {
    new RegExp(source, 'i')
    return true
  } catch {
    return false
  }
}

export interface DueAction {
  /** `<action>|<rule id>|<event id>`: fired once. */
  key: string
  action: 'remind' | 'brief'
  event: CalendarEvent
  /** `DEFAULT_REMINDER_ID` for the default reminder. */
  ruleId: string
  message?: string
  automationId?: string
}

export function actionKey(action: DueAction['action'], ruleId: string, eventId: string): string {
  return `${action}|${ruleId}|${eventId}`
}

const isDue = (event: CalendarEvent, leadMinutes: number, now: number) => now >= event.start - leadMinutes * 60_000 && now < event.start + LATE_GRACE_MS

/**
 * What should happen now: reminders and briefs whose moment came (from `leadMinutes` before the
 * start until shortly after it) and that have not fired yet. All-day events are never reminded.
 * A matching reminder rule replaces the default reminder for that event; an event gets one brief,
 * from the first matching brief rule.
 */
export function dueActions(events: readonly CalendarEvent[], settings: Pick<PlannerSettings, 'rules' | 'reminderLeadMinutes'>, now: number, fired: (key: string) => boolean): DueAction[] {
  const out: DueAction[] = []
  const rules = settings.rules.filter((r) => r.enabled)
  for (const event of events) {
    if (event.allDay) continue
    const matching = rules.filter((r) => ruleMatches(r, event))
    const reminders = matching.filter((r) => r.action === 'remind')
    if (!reminders.length && settings.reminderLeadMinutes > 0 && isDue(event, settings.reminderLeadMinutes, now)) {
      const key = actionKey('remind', DEFAULT_REMINDER_ID, event.id)
      if (!fired(key)) out.push({ key, action: 'remind', event, ruleId: DEFAULT_REMINDER_ID })
    }
    for (const rule of reminders) {
      if (!isDue(event, rule.leadMinutes, now)) continue
      const key = actionKey('remind', rule.id, event.id)
      if (!fired(key)) out.push({ key, action: 'remind', event, ruleId: rule.id, ...(rule.message?.trim() ? { message: rule.message.trim() } : {}) })
    }
    const brief = matching.find((r) => r.action === 'brief')
    if (brief && isDue(event, brief.leadMinutes, now)) {
      const key = actionKey('brief', brief.id, event.id)
      if (!fired(key)) out.push({ key, action: 'brief', event, ruleId: brief.id, ...(brief.automationId ? { automationId: brief.automationId } : {}) })
    }
  }
  return out
}

/** Fired keys younger than `keepMs`. */
export function pruneFired(fired: Readonly<Record<string, number>>, now: number, keepMs = FIRED_KEEP_MS): Record<string, number> {
  return Object.fromEntries(Object.entries(fired).filter(([, at]) => now - at < keepMs))
}

/** A fresh rule id that is not taken. */
export function newRuleId(taken: readonly string[]): string {
  for (let n = taken.length + 1; ; n++) {
    const id = `rule-${n}`
    if (!taken.includes(id)) return id
  }
}
