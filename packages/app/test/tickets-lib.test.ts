import { describe, expect, it } from 'vitest'
import { keyProviders, relativeTime, sessionRefs, slugify, splitLinks, uniqueConnectionId } from '../src/renderer/lib/tickets'

describe('splitLinks', () => {
  it('splits text around http links and keeps trailing punctuation out of the link', () => {
    expect(splitLinks('See https://example.com/a/b. Then (https://x.test/y) ok')).toEqual([
      { kind: 'text', text: 'See ' },
      { kind: 'link', url: 'https://example.com/a/b' },
      { kind: 'text', text: '. Then (' },
      { kind: 'link', url: 'https://x.test/y' },
      { kind: 'text', text: ') ok' }
    ])
  })
  it('leaves other schemes and plain text alone', () => {
    expect(splitLinks('javascript:alert(1) and ftp://x')).toEqual([{ kind: 'text', text: 'javascript:alert(1) and ftp://x' }])
    expect(splitLinks('')).toEqual([])
  })
})

describe('relativeTime', () => {
  const now = Date.parse('2026-10-27T12:00:00Z')
  it('speaks in the chosen language', () => {
    expect(relativeTime(now - 3 * 3_600_000, now, 'en')).toBe('3 hours ago')
    expect(relativeTime(now - 3 * 3_600_000, now, 'es')).toBe('hace 3 horas')
    expect(relativeTime(now - 2 * 86_400_000, now, 'en')).toBe('2 days ago')
    expect(relativeTime(now - 5_000, now, 'en')).toBe('this minute')
  })
})

describe('connection ids', () => {
  it('slugifies names and avoids taken ids', () => {
    expect(slugify('  Acme Jira (Ñandú) ')).toBe('acme-jira-nandu')
    expect(uniqueConnectionId('Jira', [])).toBe('jira')
    expect(uniqueConnectionId('Jira', ['jira', 'jira-2'])).toBe('jira-3')
    expect(uniqueConnectionId('???', [])).toBe('tracker')
  })
})

describe('keyProviders and sessionRefs', () => {
  it('uses the profile tracker and its project keys', () => {
    expect(keyProviders({ state: 'ready', provider: 'jira', projectKeys: ['ABC'] })).toEqual([{ provider: 'jira', projectKeys: ['ABC'] }])
    expect(keyProviders({ state: 'ready', provider: 'linear', projectKeys: [] })).toEqual([{ provider: 'linear', projectKeys: undefined }])
    expect(keyProviders({ state: 'noConnection', projectKeys: [] })).toEqual([])
  })

  it('turns sessions into link facts', () => {
    const s = { view: { id: 's1', label: 'Fix ABC-1', cwd: '/work/app', state: 'ready' }, monitor: { ticketKeys: ['ABC-1'] }, items: [], output: [] }
    expect(sessionRefs([s as never])).toEqual([{ id: 's1', title: 'Fix ABC-1', cwd: '/work/app', ticketKeys: ['ABC-1'], state: 'ready' }])
  })
})
