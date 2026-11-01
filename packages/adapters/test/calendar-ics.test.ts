import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { productCalendarEvents } from '@workhub/core'
import { DemoCalendarSource, demoCalendarEvents, ICS_MAX_BYTES, IcsCalendarSource, normalizeIcsUrl } from '../src/calendar-ics'
import { fetchClient, TooLargeError, type HttpClient, type HttpRequest } from '../src/shared/http'

const WINDOW = { from: Date.UTC(2026, 10, 1), to: Date.UTC(2026, 10, 15) }
const ICS = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:e1', 'SUMMARY:Planning', 'DTSTART:20261103T150000Z', 'DTEND:20261103T160000Z', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n')
const SECRET_URL = 'https://calendar.example.com/ical/acme/private-0123456789abcdef/basic.ics'

function client(answer: (r: HttpRequest) => Promise<{ status: number; text: string }>): { http: HttpClient; calls: HttpRequest[] } {
  const calls: HttpRequest[] = []
  return {
    calls,
    http: async (r) => {
      calls.push(r)
      return answer(r)
    }
  }
}

describe('normalizeIcsUrl', () => {
  it('turns webcal into https and refuses anything but https (and a local test server)', () => {
    expect(normalizeIcsUrl(' webcal://p01-calendars.example.com/published/2/abc ')).toBe('https://p01-calendars.example.com/published/2/abc')
    expect(normalizeIcsUrl(SECRET_URL)).toBe(SECRET_URL)
    expect(normalizeIcsUrl('http://calendar.example.com/x.ics')).toBeNull()
    expect(normalizeIcsUrl('http://127.0.0.1:8080/x.ics')).toBe('http://127.0.0.1:8080/x.ics')
    expect(normalizeIcsUrl('not a url')).toBeNull()
  })
})

describe('IcsCalendarSource', () => {
  it('fetches with a timeout and a size cap, and parses the events', async () => {
    const { http, calls } = client(async () => ({ status: 200, text: ICS }))
    const r = await new IcsCalendarSource({ http }).read({ url: SECRET_URL.replace('https', 'webcal'), calendarId: 'cal', window: WINDOW })
    expect(r).toMatchObject({ ok: true, events: [{ title: 'Planning', calendarId: 'cal' }] })
    expect(calls[0]).toMatchObject({ method: 'GET', url: SECRET_URL, timeoutMs: 20_000, maxBytes: ICS_MAX_BYTES })
  })

  it('names typed failures and never puts the secret address in them', async () => {
    const read = (answer: Parameters<typeof client>[0]) => new IcsCalendarSource({ http: client(answer).http }).read({ url: SECRET_URL, calendarId: 'cal', window: WINDOW })
    const results = [
      await read(async () => ({ status: 404, text: 'Not found' })),
      await read(async () => ({ status: 403, text: '' })),
      await read(async () => ({ status: 500, text: '' })),
      await read(async () => ({ status: 200, text: '<html>Sign in</html>' })),
      await read(async () => {
        throw new TooLargeError(ICS_MAX_BYTES)
      }),
      await read(async () => {
        throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { name: 'TypeError' })
      })
    ]
    expect(results.map((r) => (r.ok ? 'ok' : r.failure))).toEqual(['unauthorized', 'unauthorized', 'unreachable', 'notCalendar', 'tooLarge', 'unreachable'])
    for (const r of results) expect(JSON.stringify(r)).not.toContain('private-0123456789abcdef')
    expect(await new IcsCalendarSource({ http: client(async () => ({ status: 200, text: ICS })).http }).read({ url: 'ftp://x', calendarId: 'c', window: WINDOW })).toMatchObject({ ok: false, failure: 'unreachable' })
  })
})

describe('demo calendar', () => {
  it('serves meetings around now, one of them coming up soon', async () => {
    const now = new Date(2026, 10, 2, 10, 2).getTime()
    const events = demoCalendarEvents(now)
    expect(events.length).toBeGreaterThanOrEqual(5)
    const next = events.find((e) => !e.allDay && e.start > now)!
    expect(next.start - now).toBeLessThanOrEqual(15 * 60_000)
    const r = await new DemoCalendarSource(() => now).read({ url: '', calendarId: 'demo', window: { from: now - 86_400_000, to: now + 14 * 86_400_000 } })
    expect(r.ok && r.events.every((e) => e.calendarId === 'demo')).toBe(true)
  })
})

describe('demo calendar with a scenario', () => {
  it('serves the events the scenario builds, under the asked calendar id', async () => {
    const now = new Date(2026, 10, 2, 10, 2).getTime()
    const r = await new DemoCalendarSource(() => now, productCalendarEvents).read({ url: '', calendarId: 'demo', window: { from: now - 86_400_000, to: now + 14 * 86_400_000 } })
    expect(r.ok && r.events.some((e) => e.title === 'Activation metrics review') && r.events.every((e) => e.calendarId === 'demo')).toBe(true)
  })
})

describe('fetchClient maxBytes', () => {
  it('stops reading a body over the cap', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/calendar' })
      res.write('x'.repeat(4000))
      res.end('y'.repeat(4000))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/feed.ics`
    try {
      await expect(fetchClient({ method: 'GET', url, headers: {}, maxBytes: 1000 })).rejects.toBeInstanceOf(TooLargeError)
      expect((await fetchClient({ method: 'GET', url, headers: {}, maxBytes: 10_000 })).text).toHaveLength(8000)
    } finally {
      server.close()
    }
  })
})
