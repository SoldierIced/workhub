import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { MilestoneOpenTickets } from '@workhub/core'
import { shortDateRange } from '../src/web/plan-data'
import { OpenTicketsList } from '../src/web/screens/MilestoneScreen'
import { translate } from '../src/renderer/i18n/translate'
import { explainsBehind } from '../src/renderer/lib/planner'

const base = { title: 'Fix the rounding', status: 'To Do', category: 'todo' as const }
const open = (tickets: MilestoneOpenTickets['tickets'], extra: Partial<MilestoneOpenTickets> = {}): MilestoneOpenTickets => ({ tickets, total: tickets.length, unassigned: 0, stale: 0, addedLate: 0, ...extra })
const html = (o: MilestoneOpenTickets) => renderToStaticMarkup(createElement(OpenTicketsList, { open: o }))
const fmt = (d: Date, o?: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en', o).format(d)

describe('the phone milestone: open tickets', () => {
  it('shows key, title, a badge per flag, the owner and the last update; a row with an address is a button', () => {
    const out = html(open([{ ...base, key: 'ACME-1', url: 'https://tracker.example.com/ACME-1', assignee: 'Ana Costa', updatedAt: Date.now() - 9 * 86_400_000, flags: ['stale', 'addedLate'] }]))
    expect(out).toContain('ACME-1')
    expect(out).toContain('Fix the rounding')
    expect(out).toContain('No movement')
    expect(out).toContain('Added after the start')
    expect(out).toContain('Ana Costa')
    expect(out).toContain('updated 9 days ago')
    expect(out).toContain('aria-label="ACME-1 Fix the rounding, No movement, Added after the start, Ana Costa, updated 9 days ago. Open in the browser"')
    expect(out).toContain('min-h-11')
  })

  it('has no button for a ticket without an address, and no owner line for an unknown owner', () => {
    const out = html(open([{ ...base, key: 'ACME-2', flags: [] }]))
    expect(out).not.toContain('<button')
    expect(out).not.toContain('updated')
  })

  it('says how many more there are, with a link only when the query has an address', () => {
    const t = [{ ...base, key: 'ACME-3', flags: [] }]
    const more = html(open(t, { total: 9, url: 'https://tracker.example.com/search' }))
    expect(more).toContain('+8 more open tickets not listed')
    expect(more).toContain('See them all in the tracker')
    expect(html(open(t, { total: 9 }))).not.toContain('See them all')
    expect(html(open(t))).not.toContain('more open')
  })

  it('has its strings in Spanish too', () => {
    for (const key of ['web.milestone.loading', 'web.milestone.unreachable', 'web.milestone.empty', 'web.milestone.unknown', 'web.milestone.openRow'] as const) {
      expect(translate('es', key)).not.toBe(translate('en', key))
    }
  })

  it('explains why only when late or at risk', () => {
    expect(['late', 'atRisk'].map((s) => explainsBehind(s as 'late'))).toEqual([true, true])
    expect(explainsBehind('onTrack')).toBe(false)
  })
})

describe('the phone milestone: "unknown" is not "none"', () => {
  it('has different words for a milestone not counted yet and one with no open ticket', () => {
    const unknown = translate('en', 'web.milestone.unknown')
    expect(unknown).not.toBe(translate('en', 'web.milestone.empty'))
    expect(unknown).toMatch(/not known/i)
    expect(unknown).toMatch(/counted again on the computer/)
    expect(translate('es', 'web.milestone.unknown')).toMatch(/Todav/)
  })
})

describe('the phone milestone: "No movement" is worked out when shown', () => {
  it('flags a ticket that became stale after the count, with the number the same clock gives', () => {
    const counted = Date.UTC(2026, 10, 1)
    const o = open([{ ...base, key: 'ACME-4', updatedAt: counted - 6 * 86_400_000, flags: [] }])
    const at = (now: number) => renderToStaticMarkup(createElement(OpenTicketsList, { open: o, now }))
    expect(at(counted)).not.toContain('No movement')
    expect(at(counted + 3 * 86_400_000)).toContain('No movement')
    expect(at(counted + 3 * 86_400_000)).toContain('updated 9 days ago')
  })
})

describe('shortDateRange', () => {
  const now = new Date(2026, 10, 19)
  it('is short, without the year in the current year', () => {
    expect(shortDateRange('2026-08-26', '2026-11-15', fmt, '{start} – {end}', now)).toBe('Aug 26 – Nov 15')
  })
  it('adds the year when a day is in another year, and keeps what it cannot read', () => {
    expect(shortDateRange('2026-12-01', '2027-01-15', fmt, '{start} – {end}', now)).toBe('Dec 1, 2026 – Jan 15, 2027')
    expect(shortDateRange('soon', '2026-01-01', fmt, '{start} – {end}', now)).toBe('soon – 2026-01-01')
  })
})
