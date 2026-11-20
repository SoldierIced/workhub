import { describe, expect, it } from 'vitest'
import { emptyConfig, type AgentAccount, type HistoryEntry, type SessionHistorySource, type WorkhubConfig } from '@workhub/core'
import { canResume, historyAccounts, listAllHistory } from '../src/main/history'
import { BUILTIN_AGENTS } from '@workhub/core'
import { accountEnvHintKey, availabilityNote, installHintKey } from '../src/renderer/lib/agents'
import { en } from '../src/renderer/i18n/en'

const agent = (id: string) => BUILTIN_AGENTS.find((a) => a.id === id)!
const account = (over: Partial<AgentAccount>): AgentAccount => ({ id: 'a', agentId: 'codex', name: 'A', ...over })
const config = (accounts: AgentAccount[] = []): WorkhubConfig => ({ ...emptyConfig(), accounts })

const entry = (agentId: string, id: string, lastModified: number): HistoryEntry => ({ agentId, accountId: null, agentSessionId: id, title: id, lastModified })
const source = (entries: HistoryEntry[]): SessionHistorySource => ({ list: async () => entries, messages: async () => [] })

describe('history accounts per agent', () => {
  it('lists the default folder once for agents with one data folder', () => {
    expect(historyAccounts(config([account({ agentId: 'kiro' })]), agent('kiro'), '/home/u')).toEqual([{ accountId: null, name: '' }])
  })

  it('adds the accounts that set a config folder for agents that support one', () => {
    const c = config([account({ id: 'w', name: 'Work', configDir: '/tmp/codex-w' }), account({ id: 'x', name: 'No folder' })])
    expect(historyAccounts(c, agent('codex'), '/home/u')).toEqual([
      { accountId: null, name: '' },
      { accountId: 'w', name: 'Work', configDir: '/tmp/codex-w' }
    ])
  })
})

describe('listAllHistory', () => {
  it('merges every agent, newest first, tagging agent, name and whether it can resume (in the terminal too)', async () => {
    const result = await listAllHistory(config(), '/home/u', {
      claude: source([entry('claude', 'c1', 10)]),
      kiro: source([entry('kiro', 'k1', 30)]),
      codex: source([entry('codex', 'x1', 20)])
    })
    expect(result.errors).toEqual([])
    expect(result.entries.map((e) => [e.agentId, e.agentName, e.resumable, e.consoleResumable])).toEqual([
      ['kiro', 'Kiro', true, false],
      ['codex', 'Codex', true, false],
      ['claude', 'Claude Code', true, true]
    ])
  })

  it('reports an agent that fails and keeps the others', async () => {
    const failing: SessionHistorySource = { list: async () => Promise.reject(new Error('database is locked')), messages: async () => [] }
    const result = await listAllHistory(config(), '/home/u', { opencode: failing, kiro: source([entry('kiro', 'k1', 1)]) })
    expect(result.errors).toEqual([{ account: 'OpenCode', message: 'database is locked' }])
    expect(result.entries.map((e) => e.agentSessionId)).toEqual(['k1'])
  })

  it('marks an account with more sessions than the depth as truncated, never as fully listed', async () => {
    const many = Array.from({ length: 6 }, (_, i) => entry('kiro', `k${i}`, 100 - i))
    const limits: (number | undefined)[] = []
    const kiro: SessionHistorySource = { list: async (_a, o) => (limits.push(o?.limit), many.slice(0, o?.limit)), messages: async () => [] }
    const cut = await listAllHistory(config(), '/home/u', { kiro }, { depth: 4 })
    expect(limits).toEqual([5])
    expect(cut.entries.map((e) => e.agentSessionId)).toEqual(['k0', 'k1', 'k2', 'k3'])
    expect(cut.truncated).toEqual(['kiro\u0000'])
    expect(cut.listed).toEqual([])
    const whole = await listAllHistory(config(), '/home/u', { kiro }, { depth: 6 })
    expect([whole.truncated, whole.listed]).toEqual([[], ['kiro\u0000']])
  })

  it('lists the older indexed sessions still on disk of a truncated account, which is then complete for the index', async () => {
    const many = Array.from({ length: 6 }, (_, i) => entry('claude', `c${i}`, 100 - i))
    const claude: SessionHistorySource = { list: async (_a, o) => many.slice(0, o?.limit), messages: async () => [], sessionIds: async () => new Set(['c0', 'c1', 'c2', 'c4']) }
    const indexed = (agentId: string, accountId: string | null) => (agentId === 'claude' && accountId === null ? [many[1]!, many[4]!, many[5]!] : [])
    const result = await listAllHistory(config(), '/home/u', { claude }, { depth: 2, indexed })
    // c4 is older than the depth and still on disk; c5 is indexed but its transcript is gone.
    expect(result.entries.map((e) => e.agentSessionId)).toEqual(['c0', 'c1', 'c4'])
    expect(result.truncated).toEqual(['claude\u0000'])
    expect(result.listed).toEqual(['claude\u0000'])
    const failing: SessionHistorySource = { ...claude, sessionIds: async () => Promise.reject(new Error('EACCES')) }
    const unsure = await listAllHistory(config(), '/home/u', { claude: failing }, { depth: 2, indexed })
    expect([unsure.entries.length, unsure.listed]).toEqual([2, []])
  })

  it('skips agents without a history source and the Claude ACP alias', async () => {
    const result = await listAllHistory(config(), '/home/u', { claude: source([entry('claude', 'c1', 1)]) })
    expect(result.entries.map((e) => e.agentId)).toEqual(['claude'])
  })

  it('resumes only agents Workhub can reopen: native, with a console, or ACP agents that load a stored session', () => {
    expect(['claude', 'claude-acp', 'kiro', 'opencode', 'codex', 'gemini', 'shell'].map((id) => [id, canResume(agent(id))])).toEqual([
      ['claude', true],
      ['claude-acp', true],
      ['kiro', true],
      ['opencode', true],
      ['codex', true],
      ['gemini', true],
      ['shell', false]
    ])
    // A custom ACP agent resumes only when its definition says it can.
    expect(canResume({ ...agent('gemini'), id: 'acme', capabilities: { ...agent('gemini').capabilities, resume: false } })).toBe(false)
  })
})

describe('agent hints', () => {
  it('has an install hint for every built-in agent that needs one, and a generic one otherwise', () => {
    for (const id of ['kiro', 'opencode', 'codex', 'gemini', 'claude-acp']) expect(installHintKey(id)).toBe(`agent.install.${id}`)
    expect(installHintKey('my-custom-agent')).toBe('agent.install.generic')
    expect(en['agent.install.generic']).toContain('{command}')
  })

  it('has account environment hints only for the agents that document one', () => {
    expect(accountEnvHintKey('codex')).toBe('settings.envHint.codex')
    expect(accountEnvHintKey('claude')).toBeNull()
  })
})

describe('availabilityNote', () => {
  it('tags an agent missing here, one WSL cannot run yet, and one waiting for its WSL host, and nothing for one that is there', () => {
    expect(availabilityNote(false)).toBe('newSession.notInstalled')
    expect(availabilityNote('unsupported')).toBe('newSession.notInWsl')
    expect(availabilityNote('pending')).toBe('newSession.hostPending')
    expect(availabilityNote(true)).toBeNull()
    expect(availabilityNote(undefined)).toBeNull()
    for (const key of ['newSession.notInWsl', 'newSession.hostPending', 'newSession.notInWslHint']) expect(key in en).toBe(true)
  })
})
