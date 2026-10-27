import { describe, expect, it } from 'vitest'
import { emptyConfig, type AgentAccount, type HistoryEntry, type SessionHistorySource, type WorkhubConfig } from '@workhub/core'
import { canResume, historyAccounts, listAllHistory } from '../src/main/history'
import { BUILTIN_AGENTS } from '@workhub/core'
import { accountEnvHintKey, installHintKey } from '../src/renderer/lib/agents'
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
  it('merges every agent, newest first, tagging agent, name and whether it can resume', async () => {
    const result = await listAllHistory(config(), '/home/u', {
      claude: source([entry('claude', 'c1', 10)]),
      kiro: source([entry('kiro', 'k1', 30)]),
      codex: source([entry('codex', 'x1', 20)])
    })
    expect(result.errors).toEqual([])
    expect(result.entries.map((e) => [e.agentId, e.agentName, e.resumable])).toEqual([
      ['kiro', 'Kiro', false],
      ['codex', 'Codex', false],
      ['claude', 'Claude Code', true]
    ])
  })

  it('reports an agent that fails and keeps the others', async () => {
    const failing: SessionHistorySource = { list: async () => Promise.reject(new Error('database is locked')), messages: async () => [] }
    const result = await listAllHistory(config(), '/home/u', { opencode: failing, kiro: source([entry('kiro', 'k1', 1)]) })
    expect(result.errors).toEqual([{ account: 'OpenCode', message: 'database is locked' }])
    expect(result.entries.map((e) => e.agentSessionId)).toEqual(['k1'])
  })

  it('skips agents without a history source and the Claude ACP alias', async () => {
    const result = await listAllHistory(config(), '/home/u', { claude: source([entry('claude', 'c1', 1)]) })
    expect(result.entries.map((e) => e.agentId)).toEqual(['claude'])
  })

  it('resumes only agents Workhub can reopen', () => {
    expect(['claude', 'claude-acp', 'kiro', 'opencode', 'codex', 'gemini'].map((id) => [id, canResume(agent(id))])).toEqual([
      ['claude', true],
      ['claude-acp', true],
      ['kiro', false],
      ['opencode', false],
      ['codex', false],
      ['gemini', false]
    ])
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
