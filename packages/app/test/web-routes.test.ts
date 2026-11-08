import { describe, expect, it } from 'vitest'
import { parseRoute, routeFromNotification, routeHash } from '../src/web/routes'

describe('web routes', () => {
  it('parses every screen and round-trips its hash', () => {
    expect(parseRoute('')).toEqual({ screen: 'home' })
    expect(parseRoute('#')).toEqual({ screen: 'home' })
    expect(parseRoute('#new')).toEqual({ screen: 'new' })
    expect(parseRoute('#prs')).toEqual({ screen: 'pullRequests' })
    expect(parseRoute('#alerts')).toEqual({ screen: 'alerts' })
    expect(parseRoute('#settings')).toEqual({ screen: 'settings' })
    expect(parseRoute('#session/abc%2F1')).toEqual({ screen: 'session', id: 'abc/1' })
    expect(parseRoute('#pair=eyJ2IjoxfQ')).toEqual({ screen: 'pair' })
    for (const hash of ['#new', '#prs', '#alerts', '#settings', '#session/abc%2F1']) expect(routeHash(parseRoute(hash))).toBe(hash)
  })

  it('opens a notification on its session, and home when the route is unknown', () => {
    expect(routeFromNotification('#session/s1')).toEqual({ screen: 'session', id: 's1' })
    expect(routeFromNotification(undefined)).toEqual({ screen: 'home' })
    expect(routeFromNotification('#nowhere')).toEqual({ screen: 'home' })
  })
})
