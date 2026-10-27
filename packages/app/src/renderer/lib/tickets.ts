import type { SessionRef, StatusCategory, TicketKeyProvider } from '@workhub/core'
import type { TicketsStatus } from '@shared/tickets-api'
import type { Tone } from '../components/atoms'
import type { SessionData } from '../store'

/** Badge tone of a ticket status. */
export const CATEGORY_TONE: Record<StatusCategory, Tone> = { todo: 'neutral', inProgress: 'info', done: 'success' }

/** The key recognizer for a profile's tracker: its provider plus the project keys of the connection. */
export function keyProviders(status: TicketsStatus | undefined): TicketKeyProvider[] {
  if (!status?.provider) return []
  return [{ provider: status.provider, projectKeys: status.projectKeys.length > 0 ? status.projectKeys : undefined }]
}

/** What links a live session to a ticket: its label and folder, plus the keys its monitor found. */
export function sessionRefs(sessions: SessionData[]): (SessionRef & { state: string })[] {
  return sessions.map((s) => ({ id: s.view.id, title: s.view.label, cwd: s.view.cwd, ticketKeys: s.monitor.ticketKeys, state: s.view.state }))
}

export type TextPart = { kind: 'text'; text: string } | { kind: 'link'; url: string }

const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+[^\s<>"')\].,;:!?]/g

/** Splits text into plain parts and http(s) links, so a description can be shown with clickable URLs. */
export function splitLinks(text: string): TextPart[] {
  const parts: TextPart[] = []
  let last = 0
  for (const m of text.matchAll(URL_PATTERN)) {
    if (m.index > last) parts.push({ kind: 'text', text: text.slice(last, m.index) })
    parts.push({ kind: 'link', url: m[0] })
    last = m.index + m[0].length
  }
  if (last < text.length) parts.push({ kind: 'text', text: text.slice(last) })
  return parts
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 86_400_000],
  ['month', 30 * 86_400_000],
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000]
]

/** "3 hours ago" / "hace 3 horas" for a past instant; "now" under a minute. */
export function relativeTime(at: number, now: number, locale: string): string {
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  const diff = at - now
  for (const [unit, ms] of UNITS) if (Math.abs(diff) >= ms) return rtf.format(Math.round(diff / ms), unit)
  return rtf.format(0, 'minute')
}

/** A lower-case, dash-separated slug, for a connection id made from a free name. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** A connection id that no existing connection uses. */
export function uniqueConnectionId(base: string, taken: readonly string[]): string {
  const root = slugify(base) || 'tracker'
  if (!taken.includes(root)) return root
  for (let i = 2; ; i++) if (!taken.includes(`${root}-${i}`)) return `${root}-${i}`
}
