import { describe, expect, it } from 'vitest'
import { hueOf, initials } from '../src/renderer/components/atoms/Avatar'
import { shortPr } from '../src/renderer/screens/slack/ThreadList'

describe('Slack screen helpers', () => {
  it('derive initials from display names', () => {
    expect(initials('Ana López')).toBe('AL')
    expect(initials('luis')).toBe('L')
    expect(initials('Pedro (demo)')).toBe('P')
    expect(initials('marta.gomez')).toBe('MG')
    expect(initials('')).toBe('?')
  })

  it('keep one color per name', () => {
    expect(hueOf('Ana')).toBe(hueOf('Ana'))
    expect(hueOf('Ana')).toBeGreaterThanOrEqual(0)
    expect(hueOf('Ana')).toBeLessThan(360)
  })

  it('shorten pull request links to repo#number', () => {
    expect(shortPr('https://github.com/acme/web/pull/12')).toBe('web#12')
    expect(shortPr('https://gitlab.com/acme/api/-/merge_requests/7')).toBe('api#7')
    expect(shortPr('https://example.com/x')).toBe('example.com/x')
  })
})
