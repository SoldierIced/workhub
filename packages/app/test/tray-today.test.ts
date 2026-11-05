import { describe, expect, it } from 'vitest'
import type { CalendarEvent, InboxItem } from '@workhub/core'
import { TrayToday, trayCalendar, trayPlanItems } from '../src/main/tray-today'
import type { CalendarRead } from '../src/main/calendar-service'

const NOW = new Date(2026, 10, 5, 13, 0).getTime()
const MIN = 60_000

const event = (id: string, start: number, end: number, extra: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id,
  uid: id,
  title: id,
  start,
  end,
  allDay: false,
  attendees: [],
  calendarId: 'cal',
  recurring: false,
  ...extra
})

const item = (id: string, due: string | undefined, extra: Partial<InboxItem> = {}): InboxItem => ({
  id,
  kind: 'task',
  title: id,
  detail: '',
  source: { type: 'manual' },
  status: 'local',
  createdAt: 1,
  ...(due ? { due } : {}),
  ...extra
})

const read = (events: CalendarEvent[], state: CalendarRead['state'] = 'ready') => ({ state, events }) as unknown as CalendarRead

describe('tray "Today" data', () => {
  it("keeps today's timed meetings that have not ended, with their place and call link", () => {
    const events = [
      event('done', NOW - 60 * MIN, NOW - 30 * MIN),
      event('allday', new Date(2026, 10, 5).getTime(), new Date(2026, 10, 6).getTime(), { allDay: true }),
      event('call', NOW + 12 * MIN, NOW + 42 * MIN, { meetingUrl: 'https://meet.example.com/abc', location: '  ' }),
      event('room', NOW + 200 * MIN, NOW + 230 * MIN, { location: 'Room 2' }),
      event('tomorrow', NOW + 24 * 60 * MIN, NOW + 25 * 60 * MIN)
    ]
    expect(trayCalendar(events, NOW)).toEqual([
      { id: 'call', title: 'call', startsAt: NOW + 12 * MIN, endsAt: NOW + 42 * MIN, joinUrl: 'https://meet.example.com/abc' },
      { id: 'room', title: 'room', startsAt: NOW + 200 * MIN, endsAt: NOW + 230 * MIN, location: 'Room 2' }
    ])
  })

  it('flags the overdue Plan tasks', () => {
    expect(trayPlanItems([item('old', '2026-11-01'), item('today', '2026-11-05')], '2026-11-05')).toEqual([
      { id: 'old', title: 'old', overdue: true },
      { id: 'today', title: 'today' }
    ])
  })

  it('reads the active profile and remembers the call links it handed out', async () => {
    const today = new TrayToday({
      readCalendar: async () => read([event('call', NOW + 5 * MIN, NOW + 35 * MIN, { meetingUrl: 'https://meet.example.com/x' }), event('room', NOW + 90 * MIN, NOW + 120 * MIN)]),
      dueToday: async () => [item('t1', '2026-11-05')],
      now: () => NOW
    })
    const r = await today.read('acme')
    expect(r.calendar.map((e) => e.id)).toEqual(['call', 'room'])
    expect(r.planDueToday).toEqual([{ id: 't1', title: 't1' }])
    expect(today.joinUrl('call')).toBe('https://meet.example.com/x')
    expect(today.joinUrl('room')).toBeNull()
    expect(today.joinUrl('unknown')).toBeNull()
  })

  it('lists no meetings while the calendars fail or Plan is off, and no tasks without a profile', async () => {
    const failing = new TrayToday({ readCalendar: async () => read([event('a', NOW + MIN, NOW + 2 * MIN)], 'error'), dueToday: async () => [item('t', '2026-11-05')], now: () => NOW })
    expect(await failing.read(null)).toEqual({ calendar: [], planDueToday: [] })
    const broken = new TrayToday({ readCalendar: async () => Promise.reject(new Error('offline')), dueToday: async () => Promise.reject(new Error('x')), now: () => NOW })
    expect(await broken.read('acme')).toEqual({ calendar: [], planDueToday: [] })
  })
})
