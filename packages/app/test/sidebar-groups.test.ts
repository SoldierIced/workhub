import { describe, expect, it } from 'vitest'
import { automaticProfileColor, PROFILE_COLORS, profileColor, sidebarRows, type SessionGroups } from '@workhub/core'
import { groupSummary, listSessions, memberOf } from '../src/renderer/lib/sessionGroups'
import type { SessionData } from '../src/renderer/store'

function session(id: string, fields: Partial<SessionData['view']> = {}, extra: Partial<SessionData> = {}): SessionData {
  return {
    view: { id, identity: id, agentId: 'claude', accountId: null, profileId: 'acme', cwd: '/work/api', state: 'ready', startedAt: 1, agentName: 'Claude Code', adapter: 'native', ...fields },
    items: [],
    ...extra
  } as unknown as SessionData
}

const member = (key: string) => ({ key, title: key, agentKey: 'claude', cwd: '/work/api' })

describe('a group header shows when a chat inside it needs you', () => {
  const groups = (collapsed: boolean): SessionGroups => ({
    groups: [{ id: 'g', name: 'Backend', collapsed, members: [member('a'), member('b'), member('c'), member('gone')] }],
    top: [{ kind: 'group', id: 'g' }]
  })

  for (const collapsed of [false, true]) {
    it(`counts replies, questions and errors of its open sessions (${collapsed ? 'collapsed' : 'expanded'})`, () => {
      const listed = listSessions([
        session('a', {}, { unseen: 'replied' }),
        // A permission request already looked at but not answered still needs you.
        session('b', {}, { items: [{ id: 1, kind: 'permission', requestId: 'r', title: 'Run npm test', options: [] }] as unknown as SessionData['items'] }),
        session('c', { state: 'busy' })
      ])
      const [row] = sidebarRows(groups(collapsed), listed)
      expect(row?.type).toBe('group')
      if (row?.type !== 'group') return
      expect(groupSummary(row.members)).toEqual({ count: 2, level: 'needsAnswer' })
    })
  }

  it('shows nothing to do for a group whose sessions are idle or working', () => {
    const [row] = sidebarRows(groups(true), listSessions([session('a'), session('c', { state: 'busy' })]))
    if (row?.type !== 'group') throw new Error('expected a group row')
    expect(groupSummary(row.members)).toEqual({ count: 0, level: 'working' })
  })
})

describe('profile colour of a session row', () => {
  const profiles = [{ id: 'acme' }, { id: 'side', color: '#123456' }, { id: 'third' }]

  it('is the profile’s own colour, else the palette colour of its place', () => {
    expect(profileColor(profiles, 'side')).toBe('#123456')
    expect(profileColor(profiles, 'acme')).toBe(PROFILE_COLORS[0])
    expect(profileColor(profiles, 'third')).toBe(PROFILE_COLORS[2])
    expect(automaticProfileColor(PROFILE_COLORS.length + 1)).toBe(PROFILE_COLORS[1])
  })

  it('is none for a session without a known profile', () => {
    expect(profileColor(profiles, null)).toBeUndefined()
    expect(profileColor(profiles, 'deleted')).toBeUndefined()
  })

  it('is remembered by a group member, so a closed session keeps its bar', () => {
    const [listed] = listSessions([session('a', { profileId: 'side' })])
    expect(memberOf(listed!).profileId).toBe('side')
    const [none] = listSessions([session('b', { profileId: null })])
    expect('profileId' in memberOf(none!)).toBe(false)
  })
})
