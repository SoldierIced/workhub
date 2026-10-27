import { describe, expect, it } from 'vitest'
import { findTicketKeys, isTicketKey, projectOfKey, ticketKeysIn } from '../src'

const jira = { provider: 'jira' } as const
const jiraAcme = { provider: 'jira', projectKeys: ['ACME', 'web'] } as const
const gh = { provider: 'github-issues', repo: 'Acme/Shop' } as const

describe('findTicketKeys: Jira and Linear', () => {
  it('finds upper-case keys in order, without repeats', () => {
    expect(ticketKeysIn('ENG-12 fixes PROJ-7, see ENG-12 again', [jira])).toEqual(['ENG-12', 'PROJ-7'])
  })

  it('reports the provider and the first offset', () => {
    expect(findTicketKeys('fix PROJ-7', [jira])).toEqual([{ key: 'PROJ-7', provider: 'jira', index: 4 }])
  })

  it('skips well-known non-tickets when no project keys are configured', () => {
    expect(ticketKeysIn('use UTF-8, SHA-256 and ISO-8601 for PROJ-1', [jira])).toEqual(['PROJ-1'])
  })

  it('does not match lower case or embedded text without project keys', () => {
    expect(ticketKeysIn('feat/proj-12-login xPROJ-12 PROJ-12x', [jira])).toEqual([])
  })

  it('with project keys, matches branches case-insensitively and normalizes', () => {
    expect(ticketKeysIn('feat/acme-123-add-login and Web-9', [jiraAcme])).toEqual(['ACME-123', 'WEB-9'])
  })

  it('with project keys, ignores other projects', () => {
    expect(ticketKeysIn('OTHER-5 and ACME-6', [jiraAcme])).toEqual(['ACME-6'])
  })

  it('accepts a key at the edges and next to punctuation', () => {
    expect(ticketKeysIn('(PROJ-1), [PROJ-2]: PROJ-3.', [jira])).toEqual(['PROJ-1', 'PROJ-2', 'PROJ-3'])
  })

  it('ignores project keys that are not valid identifiers', () => {
    expect(ticketKeysIn('PROJ-1', [{ provider: 'jira', projectKeys: ['a|b', '(x'] }])).toEqual([])
  })

  it('returns nothing for empty text', () => {
    expect(findTicketKeys('', [jira])).toEqual([])
  })
})

describe('findTicketKeys: GitHub Issues', () => {
  it('maps a bare #123 to the configured repo, lower-cased', () => {
    expect(ticketKeysIn('Fixes #12 and closes #7', [gh])).toEqual(['acme/shop#12', 'acme/shop#7'])
  })

  it('accepts explicit refs and issue URLs of the repo only', () => {
    const text = 'see Acme/Shop#3, other/repo#4 and https://github.com/acme/shop/issues/5'
    expect(ticketKeysIn(text, [gh])).toEqual(['acme/shop#3', 'acme/shop#5'])
  })

  it('does not treat pull request URLs or anchors as issues', () => {
    expect(ticketKeysIn('https://github.com/acme/shop/pull/9 and page#section and &#39;', [gh])).toEqual([])
  })

  it('without a repo, only explicit refs match', () => {
    expect(ticketKeysIn('#12 and a/b#3', [{ provider: 'github-issues' }])).toEqual(['a/b#3'])
  })
})

describe('findTicketKeys: several providers', () => {
  it('assigns a shared shape to the first provider and merges in text order', () => {
    const matches = findTicketKeys('#4 then ENG-9', [{ provider: 'linear' }, gh])
    expect(matches.map((m) => [m.key, m.provider])).toEqual([
      ['acme/shop#4', 'github-issues'],
      ['ENG-9', 'linear']
    ])
  })
})

describe('isTicketKey and projectOfKey', () => {
  it('accepts exactly one key', () => {
    expect(isTicketKey('ABC-123', jira)).toBe(true)
    expect(isTicketKey('abc-123', jira)).toBe(false)
    expect(isTicketKey('abc-123', jiraAcme)).toBe(false)
    expect(isTicketKey('acme-123', jiraAcme)).toBe(true)
    expect(isTicketKey('ABC-123 DEF-4', jira)).toBe(false)
    expect(isTicketKey('#5', gh)).toBe(true)
    expect(isTicketKey('see #5', gh)).toBe(false)
    expect(isTicketKey('https://github.com/acme/shop/issues/5', gh)).toBe(true)
  })

  it('reads the project of a key', () => {
    expect(projectOfKey('ABC-123')).toBe('ABC')
    expect(projectOfKey('acme/shop#1')).toBeNull()
  })
})
