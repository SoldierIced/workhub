import { describe, expect, it } from 'vitest'
import { configSchema, orderAgents, pickAgent, resolveEffectiveAgents } from '../src'
import { claudeA, claudeB, config, kiroWork, profile } from './fixtures'

const setup = (preferredAgents?: string[]) => {
  const p = profile({ accountIds: ['claude-a', 'claude-b', 'kiro-work'], preferredAgents })
  const c = config({ accounts: [claudeA, claudeB, kiroWork], profiles: [p] })
  return { p, agents: resolveEffectiveAgents(c, 'acme') }
}

describe('pickAgent', () => {
  it('falls back to Claude first, then the first app-mode agent, when nothing is preferred', () => {
    const { p, agents } = setup()
    expect(pickAgent(p, agents, 'claude')?.key).toBe('claude:claude-a')
    expect(pickAgent(p, agents, 'appMode')?.key).toBe('claude:claude-a')
    expect(pickAgent(undefined, agents, 'any')?.key).toBe('claude:claude-a')
    expect(pickAgent(p, agents.filter((e) => e.agent.id !== 'claude'), 'appMode')?.agent.capabilities.appMode).toBe(true)
  })

  it('takes the preferred Claude when it is the second one configured', () => {
    const { p, agents } = setup(['claude:claude-b'])
    expect(pickAgent(p, agents, 'claude')?.key).toBe('claude:claude-b')
    expect(pickAgent(p, agents, 'appMode')?.key).toBe('claude:claude-b')
    expect(pickAgent(p, agents, 'any')?.key).toBe('claude:claude-b')
  })

  it('respects the order of the list and skips agents that do not fit the requirement', () => {
    const { p, agents } = setup(['shell', 'kiro:kiro-work', 'claude:claude-b'])
    expect(pickAgent(p, agents, 'any')?.key).toBe('shell')
    expect(pickAgent(p, agents, 'appMode')?.key).toBe('kiro:kiro-work')
    // "Ask Claude to review" needs a Claude agent whatever comes first in the list.
    expect(pickAgent(p, agents, 'claude')?.key).toBe('claude:claude-b')
  })

  it('ignores stale keys and returns undefined when no agent fits', () => {
    const { p, agents } = setup(['gone', 'claude:nobody'])
    expect(pickAgent(p, agents, 'claude')?.key).toBe('claude:claude-a')
    expect(pickAgent(p, agents.filter((e) => e.agent.id !== 'claude'), 'claude')).toBeUndefined()
    expect(pickAgent(p, [], 'any')).toBeUndefined()
  })
})

describe('orderAgents', () => {
  it('puts the preferred agents first, as listed, and keeps the rest in offered order', () => {
    const { agents } = setup()
    const keys = orderAgents(['kiro:kiro-work', 'gone', 'claude:claude-b', 'claude:claude-b'], agents).map((e) => e.key)
    expect(keys.slice(0, 2)).toEqual(['kiro:kiro-work', 'claude:claude-b'])
    expect(keys).toHaveLength(agents.length)
    expect(new Set(keys).size).toBe(agents.length)
  })
})

describe('profile.preferredAgents in the config', () => {
  it('parses an existing profile without it unchanged, and keeps a saved order', () => {
    const base = { version: 4, profiles: [{ id: 'acme', name: 'Acme' }] }
    expect(configSchema.parse(base).profiles[0]).not.toHaveProperty('preferredAgents')
    const withOrder = { ...base, profiles: [{ id: 'acme', name: 'Acme', preferredAgents: ['claude:claude-b'] }] }
    expect(configSchema.parse(withOrder).profiles[0]?.preferredAgents).toEqual(['claude:claude-b'])
  })
})
