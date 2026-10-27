import { describe, expect, it } from 'vitest'
import {
  accountAgent,
  BUILTIN_AGENTS,
  canSetModel,
  canSetSessionMode,
  CONFIG_VERSION,
  creditSpend,
  hasSessionControls,
  parseConfig,
  startOfLocalDay,
  type AgentRuntime
} from '../src'

const kiro = BUILTIN_AGENTS.find((a) => a.id === 'kiro')!

describe('account settings for any agent', () => {
  it('keeps command, default model and default mode of an account through the schema', () => {
    const parsed = parseConfig({
      version: CONFIG_VERSION,
      accounts: [{ id: 'kiro-work', agentId: 'kiro', name: 'Work', command: ' /opt/kiro/bin/kiro-cli ', defaultModel: 'claude-sonnet-5.5', defaultMode: 'explorer' }]
    })
    expect(parsed.accounts[0]).toEqual({ id: 'kiro-work', agentId: 'kiro', name: 'Work', command: '/opt/kiro/bin/kiro-cli', defaultModel: 'claude-sonnet-5.5', defaultMode: 'explorer' })
  })

  it('loads an account without them unchanged', () => {
    const parsed = parseConfig({ version: CONFIG_VERSION, accounts: [{ id: 'a', agentId: 'claude', name: 'A' }] })
    expect(parsed.accounts[0]).toEqual({ id: 'a', agentId: 'claude', name: 'A' })
  })

  it('runs the account command instead of the agent one, keeping the args', () => {
    expect(accountAgent(kiro, { command: '/opt/kiro/bin/kiro-cli' })).toMatchObject({ command: '/opt/kiro/bin/kiro-cli', args: ['acp'] })
    expect(accountAgent(kiro, { command: '  ' })).toBe(kiro)
    expect(accountAgent(kiro, null)).toBe(kiro)
  })
})

describe('runtime control guards', () => {
  const base = { adapter: 'acp' } as unknown as AgentRuntime
  it('tells model and mode switching apart from the MCP controls', () => {
    const acp = Object.assign(Object.create(null), base, { setModel: async () => {}, setSessionMode: async () => {} }) as AgentRuntime
    expect(canSetModel(acp)).toBe(true)
    expect(canSetSessionMode(acp)).toBe(true)
    expect(hasSessionControls(acp)).toBe(false)
    expect(canSetModel(base)).toBe(false)
    expect(canSetSessionMode(base)).toBe(false)
  })
})

describe('creditSpend', () => {
  // A Wednesday at 15:00 local time.
  const now = new Date(2026, 9, 28, 15, 0, 0).getTime()
  const at = (daysBack: number, hour: number) => startOfLocalDay(now, daysBack) + hour * 3_600_000

  it('sums today, the last 7 local days and each day', () => {
    const spend = creditSpend(
      [
        { at: at(0, 9), credits: 1.5 },
        { at: at(0, 14), credits: 0.25 },
        { at: at(1, 23), credits: 2 },
        { at: at(6, 1), credits: 1 },
        // Older than 7 days, in the future, zero or broken: not counted.
        { at: at(7, 12), credits: 5 },
        { at: now + 60_000, credits: 3 },
        { at: at(2, 10), credits: 0 },
        { at: Number.NaN, credits: 1 }
      ],
      now
    )
    expect(spend.today).toBeCloseTo(1.75)
    expect(spend.week).toBeCloseTo(4.75)
    expect(spend.turns).toBe(4)
    expect(spend.days).toHaveLength(7)
    expect(spend.days[6]).toEqual({ day: '2026-10-28', credits: 1.75 })
    expect(spend.days[5]).toEqual({ day: '2026-10-27', credits: 2 })
    expect(spend.days[0]).toEqual({ day: '2026-10-22', credits: 1 })
  })

  it('is all zeros with nothing spent', () => {
    expect(creditSpend([], now)).toMatchObject({ today: 0, week: 0, turns: 0 })
  })
})
