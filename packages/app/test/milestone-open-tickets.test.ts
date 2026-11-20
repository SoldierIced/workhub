import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { MilestoneOpenTickets } from '@workhub/core'
import { openTicketsAt } from '@workhub/core'
import { translate } from '../src/renderer/i18n/translate'
import { openTicketsSummary } from '../src/renderer/lib/planner'
import { OpenTicketsBlock, OpenTicketsList } from '../src/renderer/screens/plan/MilestoneOpenTickets'

const open = (tickets: MilestoneOpenTickets['tickets']): MilestoneOpenTickets => ({ tickets, total: tickets.length, unassigned: 0, stale: 0, addedLate: 0 })
const base = { title: 'x', status: 'To Do', category: 'todo' as const }
const count = (html: string, text: string) => html.split(text).length - 1

describe('open tickets list', () => {
  it('says "No owner" once for a ticket nobody has, as the badge', () => {
    const html = renderToStaticMarkup(createElement(OpenTicketsList, { profileId: 'work', name: 'Beta', open: open([{ ...base, key: 'A-1', assignee: null, flags: ['unassigned'] }]) }))
    expect(count(html, 'No owner')).toBe(1)
  })

  it('shows the owner text only when someone has the ticket, and nothing when it is unknown', () => {
    const html = renderToStaticMarkup(createElement(OpenTicketsList, { profileId: 'work', name: 'Beta', open: open([{ ...base, key: 'A-1', assignee: 'Ana Costa', flags: [] }, { ...base, key: 'A-2', flags: [] }]) }))
    expect(count(html, 'Ana Costa')).toBe(1)
    expect(html).not.toContain('No owner')
  })
})

describe('open tickets control', () => {
  it('names the milestone in the accessible name of the show button, in both languages', () => {
    const html = renderToStaticMarkup(createElement(OpenTicketsBlock, { profileId: 'work', listId: 'open-a', name: 'Beta', status: 'late', open: open([{ ...base, key: 'A-1', flags: [] }]) }))
    expect(html).toContain('aria-label="Show open tickets of Beta"')
    const other = renderToStaticMarkup(createElement(OpenTicketsBlock, { profileId: 'work', listId: 'open-b', name: 'Gamma', status: 'late', open: open([{ ...base, key: 'A-1', flags: [] }]) }))
    expect(other).toContain('aria-label="Show open tickets of Gamma"')
    expect(translate('es', 'planner.open.showFor', { name: 'Beta' })).toBe('Mostrar tickets abiertos de Beta')
    expect(translate('es', 'planner.open.hideFor', { name: 'Beta' })).toBe('Ocultar tickets abiertos de Beta')
    expect(translate('en', 'planner.open.hideFor', { name: 'Beta' })).toBe('Hide open tickets of Beta')
  })
})

describe('open tickets: the line that says why it is behind', () => {
  const summary = { tickets: [{ ...base, key: 'A-1', flags: [] }], total: 5, unassigned: 2, stale: 0, addedLate: 0 }
  const block = (status: 'late' | 'atRisk' | 'onTrack' | 'done' | 'notStarted') => renderToStaticMarkup(createElement(OpenTicketsBlock, { profileId: 'work', listId: 'open-a', name: 'Beta', status, open: summary }))

  it('shows the line for Late and At risk, with the show control', () => {
    for (const status of ['late', 'atRisk'] as const) {
      const html = block(status)
      expect(html).toContain('5 open · 2 with no owner')
      expect(html).toContain('Show open tickets')
    }
  })

  it('shows only the control, saying how many there are, for any other status', () => {
    for (const status of ['onTrack', 'done', 'notStarted'] as const) {
      const html = block(status)
      expect(html).not.toContain('with no owner')
      expect(html).toContain('5 open tickets')
    }
    expect(renderToStaticMarkup(createElement(OpenTicketsBlock, { profileId: 'work', listId: 'x', name: 'B', status: 'onTrack', open: { ...summary, total: 1 } }))).toContain('1 open ticket<')
  })

  it('has the count of the control in both languages', () => {
    expect(translate('es', 'planner.open.control.other', { count: 5 })).toBe('5 tickets abiertos')
    expect(translate('es', 'planner.open.control.one', { count: 1 })).toBe('1 ticket abierto')
  })
})

describe('open tickets: the link of the last line', () => {
  const more = (url?: string) => renderToStaticMarkup(createElement(OpenTicketsList, { profileId: 'work', name: 'Beta', open: { ...open([{ ...base, key: 'A-1', flags: [] }]), total: 60, ...(url ? { url } : {}) } }))

  it('offers the query in the tracker when there are more open tickets than listed and the tracker gave an address', () => {
    const html = more('https://tracker.example.com/search?q=1')
    expect(html).toContain('+59 more open tickets not listed')
    expect(html).toContain('See them all in the tracker')
  })

  it('has no link without an address, or when nothing is left out', () => {
    expect(more()).not.toContain('See them all')
    const all = renderToStaticMarkup(createElement(OpenTicketsList, { profileId: 'work', name: 'Beta', open: { ...open([{ ...base, key: 'A-1', flags: [] }]), url: 'https://tracker.example.com/search?q=1' } }))
    expect(all).not.toContain('See them all')
    expect(translate('es', 'planner.open.seeAll')).toBe('Verlos todos en el tracker')
  })
})

describe('open tickets: accessible names', () => {
  const name = (html: string) => /<button[^>]*aria-label="([^"]*)"/.exec(html)?.[1]
  const control = (status: 'late' | 'onTrack', milestone: string) => renderToStaticMarkup(createElement(OpenTicketsBlock, { profileId: 'work', listId: 'x', name: milestone, status, open: { ...open([{ ...base, key: 'A-1', flags: [] }]), total: 5 } }))

  it('on a milestone that is not behind, the name has the visible text and the milestone', () => {
    const html = control('onTrack', 'Beta')
    expect(html).toContain('5 open tickets<')
    expect(name(html)).toBe('Show 5 open tickets of Beta')
    expect(name(html)).toContain('5 open tickets')
  })

  it('on a late milestone, the name still has the visible text and the milestone', () => {
    const html = control('late', 'Beta')
    expect(html).toContain('Show open tickets<')
    expect(name(html)).toBe('Show open tickets of Beta')
  })

  it('has the counted names in Spanish, singular and plural', () => {
    expect(translate('es', 'planner.open.showCountFor.one', { count: 1, name: 'Beta' })).toBe('Mostrar 1 ticket abierto de Beta')
    expect(translate('es', 'planner.open.hideCountFor.other', { count: 5, name: 'Beta' })).toBe('Ocultar 5 tickets abiertos de Beta')
  })

  it('says which milestone "See them all in the tracker" is for', () => {
    const more = (milestone: string) => renderToStaticMarkup(createElement(OpenTicketsList, { profileId: 'work', name: milestone, open: { ...open([{ ...base, key: 'A-1', flags: [] }]), total: 60, url: 'https://tracker.example.com/s' } }))
    expect(name(more('Beta'))).toBe('See them all in the tracker for Beta')
    expect(name(more('Gamma'))).toBe('See them all in the tracker for Gamma')
    expect(translate('es', 'planner.open.seeAllFor', { name: 'Beta' })).toBe('Verlos todos en el tracker de Beta')
  })
})

describe('open tickets: "No movement" is worked out when shown', () => {
  const DAY = 86_400_000
  const counted = Date.UTC(2026, 10, 1)
  const stored = { ...open([{ ...base, key: 'A-1', assignee: 'Ana Costa', updatedAt: counted - 6 * DAY, flags: [] }]), stale: 0 }
  const list = (now: number) => renderToStaticMarkup(createElement(OpenTicketsList, { profileId: 'work', name: 'Beta', open: stored, now }))

  it('shows no badge while the ticket is recent, and the badge once it is more than 7 days old, with the same clock as "updated ... ago"', () => {
    expect(list(counted)).not.toContain('No movement')
    const later = list(counted + 3 * DAY)
    expect(later).toContain('No movement')
    expect(later).toContain('updated 9 days ago')
  })

  it('the line counts it too, through the same helper', () => {
    const tn = (base: string, n: number, params?: Record<string, string | number>) => translate('en', `${base}.${n === 1 ? 'one' : 'other'}` as 'planner.open.stale.one', { count: n, ...params })
    expect(openTicketsSummary(openTicketsAt(stored, counted), tn)).toBe('1 open')
    expect(openTicketsSummary(openTicketsAt(stored, counted + 3 * DAY), tn)).toBe('1 open · 1 not updated in 7 days')
  })
})
