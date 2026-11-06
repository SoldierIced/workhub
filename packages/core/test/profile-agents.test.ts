import { describe, expect, it } from 'vitest'
import { BUILTIN_AGENTS, failoverCandidates, moveRow, offerRow, pickAgent, profileAgentRows, resolveEffectiveAgents, type Profile } from '../src'
import { claudeA, claudeB, config, kiroWork, profile } from './fixtures'

const ALL = BUILTIN_AGENTS.map((a) => a.id)
const setup = (over: Partial<Profile> = {}) => {
  const p = profile({ agentIds: ['claude', 'kiro', 'shell'], ...over })
  const c = config({ accounts: [claudeA, claudeB, kiroWork], profiles: [p, profile({ id: 'other', name: 'Other' })] })
  return { p, c, rows: profileAgentRows(c, 'acme') }
}
const keys = (rows: { key: string; offered: boolean }[]) => rows.map((r) => `${r.offered ? '+' : '-'}${r.key}`)

describe('profileAgentRows', () => {
  it('lists the offered rows first in the profile order, then every other candidate', () => {
    const { rows } = setup({ accountIds: ['claude-a', 'claude-b'], preferredAgents: ['claude:claude-b', 'kiro'] })
    expect(keys(rows)).toEqual(['+claude:claude-b', '+kiro', '+claude:claude-a', '+shell', '-claude-acp', '-kiro:kiro-work', '-opencode', '-codex', '-gemini'])
    expect(rows.filter((r) => r.isDefault).map((r) => r.key)).toEqual(['claude:claude-b'])
    expect(rows[0]).toMatchObject({ kind: 'account', agentId: 'claude', accountId: 'claude-b', label: 'Claude Code · Account B' })
    expect(rows.find((r) => r.key === 'kiro')).toMatchObject({ kind: 'agent', offered: true })
  })

  it('hides Claude own sign-in once the profile offers a Claude account', () => {
    expect(keys(setup().rows).slice(0, 3)).toEqual(['+claude', '+kiro', '+shell'])
    const { rows } = setup({ accountIds: ['claude-a'] })
    expect(rows.some((r) => r.key === 'claude')).toBe(false)
    expect(rows.find((r) => r.key === 'claude:claude-b')?.offered).toBe(false)
  })

  it('makes the first offered row the default, as pickAgent does', () => {
    for (const over of [{}, { accountIds: ['claude-a', 'claude-b'], preferredAgents: ['shell'] }, { agentIds: ['shell', 'claude'] }]) {
      const { p, c, rows } = setup(over)
      expect(rows.find((r) => r.isDefault)?.key).toBe(pickAgent(p, resolveEffectiveAgents(c, 'acme'), 'any')?.key)
      expect(rows[0]!.isDefault).toBe(true)
    }
  })

  it('is empty for an unknown profile', () => {
    expect(profileAgentRows(setup().c, 'nobody')).toEqual([])
  })
})

describe('offerRow', () => {
  it('offers and takes out an account, dropping it from the order', () => {
    const { p, rows } = setup({ accountIds: ['claude-a'], preferredAgents: ['claude:claude-a', 'kiro'] })
    const b = rows.find((r) => r.key === 'claude:claude-b')!
    expect(offerRow(p, b, true, ALL).accountIds).toEqual(['claude-a', 'claude-b'])
    const a = rows.find((r) => r.key === 'claude:claude-a')!
    const off = offerRow(p, a, false, ALL)
    expect(off.accountIds).toEqual([])
    expect(off.preferredAgents).toEqual(['kiro'])
  })

  it('puts a newly offered account where its agent own sign-in was in the order', () => {
    const { p, rows } = setup({ preferredAgents: ['kiro', 'claude'] })
    const a = rows.find((r) => r.key === 'claude:claude-a')!
    expect(offerRow(p, a, true, ALL).preferredAgents).toEqual(['kiro', 'claude:claude-a', 'claude'])
  })

  it('offers and takes out an agent through agentIds, spelling out "all but one" when every agent was offered', () => {
    const { p, rows } = setup()
    const codex = rows.find((r) => r.key === 'codex')!
    expect(codex.offered).toBe(false)
    expect(offerRow(p, codex, true, ALL).agentIds).toEqual(['claude', 'kiro', 'shell', 'codex'])
    const all = profile({ preferredAgents: ['shell', 'claude'] })
    const shell = { kind: 'agent' as const, agentId: 'shell', key: 'shell' }
    const off = offerRow(all, shell, false, ALL)
    expect(off.agentIds).toEqual(ALL.filter((id) => id !== 'shell'))
    expect(off.preferredAgents).toEqual(['claude'])
    expect(offerRow(all, shell, true, ALL).agentIds).toBeUndefined()
  })

  it('changes only the profile it is given', () => {
    const { c, rows } = setup()
    const other = c.profiles[1]!
    const next = offerRow(other, rows.find((r) => r.key === 'claude:claude-a')!, true, ALL)
    expect(next.id).toBe('other')
    expect(c.profiles[0]!.accountIds).toEqual([])
  })
})

describe('moveRow', () => {
  it('writes the full order of the offered rows', () => {
    const { p, rows } = setup({ accountIds: ['claude-a', 'claude-b'] })
    expect(keys(rows).slice(0, 4)).toEqual(['+claude:claude-a', '+claude:claude-b', '+kiro', '+shell'])
    expect(moveRow(p, rows, 'claude:claude-b', -1).preferredAgents).toEqual(['claude:claude-b', 'claude:claude-a', 'kiro', 'shell'])
    expect(moveRow(p, rows, 'claude:claude-a', 1).preferredAgents).toEqual(['claude:claude-b', 'claude:claude-a', 'kiro', 'shell'])
    expect(moveRow(p, rows, 'shell', -3).preferredAgents).toEqual(['shell', 'claude:claude-a', 'claude:claude-b', 'kiro'])
  })

  it('leaves the profile as it is at the ends of the list and for rows not offered', () => {
    const { p, rows } = setup({ accountIds: ['claude-a'] })
    expect(moveRow(p, rows, 'claude:claude-a', -1)).toBe(p)
    expect(moveRow(p, rows, 'shell', 1)).toBe(p)
    expect(moveRow(p, rows, 'codex', -1)).toBe(p)
  })
})

describe('failoverCandidates', () => {
  it('lists the offered Claude accounts in the list order', () => {
    const { rows } = setup({ accountIds: ['claude-a', 'claude-b', 'kiro-work'], preferredAgents: ['kiro:kiro-work', 'claude:claude-b'] })
    expect(failoverCandidates(rows).map((r) => r.key)).toEqual(['claude:claude-b', 'claude:claude-a'])
    expect(failoverCandidates(setup({ accountIds: ['claude-a'] }).rows).map((r) => r.key)).toEqual(['claude:claude-a'])
    expect(failoverCandidates(setup().rows)).toEqual([])
  })
})
