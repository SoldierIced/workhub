import { describe, expect, it } from 'vitest'
import {
  accountColor,
  applyHistory,
  CONFIG_VERSION,
  emptyConfig,
  historyOfSessions,
  needsHistoryLookup,
  parseConfig,
  PROFILE_COLORS,
  refreshMembers,
  resolveSessionName,
  type GroupMember,
  type HistoryEntry,
  type PastSessionInfo,
  type SessionGroups
} from '../src'

const groupWith = (...members: GroupMember[]): SessionGroups => ({ groups: [{ id: 'g', name: 'Work', collapsed: false, members }], top: [{ kind: 'group', id: 'g' }] })
const membersOf = (s: SessionGroups) => s.groups[0]!.members

describe('a session name', () => {
  const cwd = '/work/sistema-indumentaria'

  it('is the user’s rename first, then the agent’s title, then the first prompt, then the folder', () => {
    expect(resolveSessionName({ name: 'Billing fix', title: 'Agent title', firstPrompt: 'fix it', cwd })).toEqual({ title: 'Billing fix', titled: true })
    expect(resolveSessionName({ title: 'Agent title', firstPrompt: 'fix it', cwd })).toEqual({ title: 'Agent title', titled: true })
    expect(resolveSessionName({ firstPrompt: '\n  fix   the\tlogin\nsecond line', cwd })).toEqual({ title: 'fix the login', titled: true })
    expect(resolveSessionName({ cwd })).toEqual({ title: 'sistema-indumentaria', titled: false })
  })

  it('skips blank sources and cuts a long prompt to a row', () => {
    expect(resolveSessionName({ name: '  ', title: '', firstPrompt: 'x'.repeat(100), cwd }).title).toBe(`${'x'.repeat(59)}…`)
    expect(resolveSessionName({ name: ' ', cwd: 'C:\\work\\api\\' }).title).toBe('api')
  })
})

describe('what a group member remembers', () => {
  const live: GroupMember = {
    key: 's1',
    title: 'Fix the login',
    titled: true,
    agentKey: 'claude:work',
    cwd: '/work/api',
    agentId: 'claude',
    agentName: 'Claude Code',
    accountId: 'work',
    accountName: 'Laboral',
    profileId: 'acme'
  }

  it('keeps the name, agent, account and profile of the session once it closes', () => {
    const s = refreshMembers(groupWith({ key: 's1', title: 'api', agentKey: 'claude', cwd: '/work/api' }), [live])
    // Closing removes the session from the live list: nothing is refreshed, the record stays.
    expect(refreshMembers(s, [])).toBe(s)
    expect(membersOf(s)[0]).toEqual(live)
  })

  it('never replaces a name of its own with the folder of a session reopened without a prompt on screen', () => {
    const s = groupWith({ ...live, lookedUp: true })
    const reopened: GroupMember = { key: 's1', title: 'api', agentKey: 'claude:work', cwd: '/work/api', agentId: 'claude', agentName: 'Claude Code', accountId: 'work', profileId: 'acme' }
    const next = refreshMembers(s, [reopened])
    expect(next).toBe(s)
    expect(membersOf(next)[0]).toMatchObject({ title: 'Fix the login', titled: true, accountName: 'Laboral', lookedUp: true })
  })

  it('takes a new name and account as soon as the open session reports them', () => {
    const s = groupWith(live)
    const next = refreshMembers(s, [{ ...live, title: 'Renamed', accountId: 'personal', accountName: 'Personal', agentKey: 'claude:personal' }])
    expect(membersOf(next)[0]).toMatchObject({ title: 'Renamed', accountId: 'personal', accountName: 'Personal' })
  })

  it('survives a save and load of the config', () => {
    const config = { ...emptyConfig(), version: CONFIG_VERSION, sessionGroups: groupWith({ ...live, lookedUp: true }) }
    expect(parseConfig(JSON.parse(JSON.stringify(config))).sessionGroups).toEqual(config.sessionGroups)
  })
})

describe('looking a member up in the session history', () => {
  const entry = (fields: Partial<PastSessionInfo>): PastSessionInfo => ({
    agentId: 'claude',
    accountId: 'work',
    accountName: 'Laboral',
    agentName: 'Claude Code',
    agentSessionId: 'abc',
    title: 'Stock report by size',
    lastModified: 1,
    ...fields
  })
  const old: GroupMember = { key: 'abc', title: 'sistema-indumentaria', agentKey: 'claude:work', cwd: '/work/sistema-indumentaria' }

  it('is needed for a member saved without a name or agent, once', () => {
    expect(needsHistoryLookup(old)).toBe(true)
    expect(needsHistoryLookup({ ...old, titled: true, agentId: 'claude' })).toBe(false)
    expect(needsHistoryLookup({ ...old, lookedUp: true })).toBe(false)
  })

  it('names it by its agent session id with the newest copy, and fills its agent and account', () => {
    const entries = [entry({ title: 'Older copy', lastModified: 1 }), entry({ lastModified: 5 }), entry({ agentSessionId: 'other', title: 'Not this one' })]
    const next = applyHistory(groupWith(old), entries, new Set(['abc']))
    expect(membersOf(next)[0]).toEqual({ ...old, title: 'Stock report by size', titled: true, agentId: 'claude', agentName: 'Claude Code', accountId: 'work', accountName: 'Laboral', lookedUp: true })
  })

  it('falls back to the first prompt, ignores other agents and marks a member not found as looked up', () => {
    const prompt = applyHistory(groupWith(old), [entry({ title: '', firstPrompt: 'why is stock wrong?' })], new Set(['abc']))
    expect(membersOf(prompt)[0]).toMatchObject({ title: 'why is stock wrong?', titled: true })
    const otherAgent = applyHistory(groupWith(old), [entry({ agentId: 'codex' })], new Set(['abc']))
    expect(membersOf(otherAgent)[0]).toEqual({ ...old, lookedUp: true })
  })

  it('keeps a name of its own and leaves members not searched alone', () => {
    const named: GroupMember = { ...old, title: 'My name', titled: true }
    expect(membersOf(applyHistory(groupWith(named), [entry({})], new Set(['abc'])))[0]).toMatchObject({ title: 'My name', accountName: 'Laboral' })
    const s = groupWith(old)
    expect(applyHistory(s, [entry({})], new Set(['zzz']))).toBe(s)
  })

  it('reads only the past sessions with the asked ids', () => {
    const entries = [{ agentSessionId: 'abc' }, { agentSessionId: 'def' }] as HistoryEntry[]
    expect(historyOfSessions(entries, new Set(['def']))).toEqual([{ agentSessionId: 'def' }])
  })
})

describe('account colour', () => {
  const accounts = [
    { id: 'personal', agentId: 'claude' },
    { id: 'codex-1', agentId: 'codex' },
    { id: 'work', agentId: 'claude' }
  ]

  it('is blue for an agent’s first account and purple for its second, as in Workhub 1', () => {
    expect(accountColor(accounts, 'personal')).toBe(PROFILE_COLORS[0])
    expect(accountColor(accounts, 'work')).toBe(PROFILE_COLORS[1])
    expect(accountColor(accounts, 'codex-1')).toBe(PROFILE_COLORS[0])
  })

  it('is none without an account or for one deleted', () => {
    expect(accountColor(accounts, null)).toBeUndefined()
    expect(accountColor(accounts, 'gone')).toBeUndefined()
  })
})
