import { describe, expect, it } from 'vitest'
import {
  buildHandoffBrief,
  EMPTY_FACTS,
  EMPTY_SESSION_GROUPS,
  factsFromHistory,
  failoverMode,
  failoverTargets,
  handoffTargets,
  isUsageLimitText,
  limitResetFromText,
  placeBeside,
  planFailover,
  resolveEffectiveAgents,
  createGroup,
  type AgentAccount,
  type BudgetStatus,
  type GroupMember,
  type HandoffFacts,
  type SessionGroups
} from '../src'
import { config, kiroWork, profile } from './fixtures'

const personal: AgentAccount = { id: 'personal', agentId: 'claude', name: 'Personal' }
const laboral: AgentAccount = { id: 'laboral', agentId: 'claude', name: 'Laboral', configDir: '/tmp/claude-laboral' }
const spare: AgentAccount = { id: 'spare', agentId: 'claude', name: 'Spare', configDir: '/tmp/claude-spare' }
const twin: AgentAccount = { id: 'twin', agentId: 'claude', name: 'Twin' }

const HOME_DIR = '/home/u/.claude'
const configDirOf = (a: AgentAccount | null) => a?.configDir ?? HOME_DIR
const allow: BudgetStatus = { action: 'allow' }

function setup(accounts: AgentAccount[], preferredAgents?: string[]) {
  const p = profile({ accountIds: accounts.map((a) => a.id), preferredAgents })
  const c = config({ accounts, profiles: [p] })
  return { p, candidates: resolveEffectiveAgents(c, 'acme') }
}

describe('isUsageLimitText', () => {
  it.each([
    'Claude AI usage limit reached|1760000000',
    "You've hit your limit · resets 3pm (America/Buenos_Aires)",
    'You’ve reached your usage limit. Upgrade or wait.',
    '5-hour limit reached ∙ resets 4am',
    'Weekly limit reached · resets Mon 9am',
    'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your rate limit"}}',
    'Usage limit reached for your plan'
  ])('detects %s', (text) => expect(isUsageLimitText(text)).toBe(true))

  it.each([
    'Context limit reached · /compact or /clear to continue',
    'Budget limit reached for this run',
    'The file exceeds the size limit',
    'I checked the rate limiter in src/limits.ts',
    '',
    undefined
  ])('ignores %s', (text) => expect(isUsageLimitText(text)).toBe(false))

  it('reads the reset of the old "|epoch" form, in seconds or ms', () => {
    expect(limitResetFromText('Claude AI usage limit reached|1760000000')).toBe(1_760_000_000_000)
    expect(limitResetFromText('Claude AI usage limit reached|1760000000000')).toBe(1_760_000_000_000)
    expect(limitResetFromText("You've hit your limit")).toBeUndefined()
  })
})

describe('failoverMode', () => {
  it('defaults to ask and rejects unknown values', () => {
    expect(failoverMode(undefined)).toBe('ask')
    expect(failoverMode({})).toBe('ask')
    expect(failoverMode({ accountFailover: 'automatic' })).toBe('automatic')
    expect(failoverMode({ accountFailover: 'nope' as never })).toBe('ask')
  })
})

describe('failoverTargets', () => {
  const source = { agentId: 'claude', accountId: 'personal', configDir: HOME_DIR }

  it('offers the other Claude accounts in the profile order, never the source or another agent', () => {
    const { p, candidates } = setup([personal, laboral, spare, kiroWork], ['claude:spare'])
    const targets = failoverTargets({ profile: p, candidates, source, configDirOf, budgetOf: () => allow, now: 0 })
    expect(targets.map((t) => t.key)).toEqual(['claude:spare', 'claude:laboral'])
  })

  it('skips an account that shares the source config folder (same login)', () => {
    const { p, candidates } = setup([personal, twin, laboral])
    expect(failoverTargets({ profile: p, candidates, source, configDirOf, budgetOf: () => allow, now: 0 }).map((t) => t.key)).toEqual(['claude:laboral'])
  })

  it('skips accounts past their ceiling, and ones that reported a limit until it resets', () => {
    const { p, candidates } = setup([personal, laboral, spare])
    const budgetOf = (_agent: string, accountId: string | null): BudgetStatus => (accountId === 'laboral' ? { action: 'block', window: '5h', percent: 99, ceiling: 90 } : allow)
    expect(failoverTargets({ profile: p, candidates, source, configDirOf, budgetOf, now: 0 }).map((t) => t.key)).toEqual(['claude:spare'])
    const limitedUntil = { 'claude:spare': 5_000 }
    expect(failoverTargets({ profile: p, candidates, source, configDirOf, budgetOf: () => allow, limitedUntil, now: 1_000 }).map((t) => t.key)).toEqual(['claude:laboral'])
    expect(failoverTargets({ profile: p, candidates, source, configDirOf, budgetOf: () => allow, limitedUntil, now: 6_000 }).map((t) => t.key)).toEqual(['claude:laboral', 'claude:spare'])
  })

  it('keeps an account whose usage is unknown or only near its ceiling (fail open)', () => {
    const { p, candidates } = setup([personal, laboral])
    const warn: BudgetStatus = { action: 'warn', window: 'weekly', percent: 88, ceiling: 90 }
    const targets = failoverTargets({ profile: p, candidates, source, configDirOf, budgetOf: () => warn, now: 0 })
    expect(targets).toEqual([{ key: 'claude:laboral', label: 'Claude Code - Laboral', accountId: 'laboral', budget: warn }])
  })
})

describe('planFailover', () => {
  const target = { key: 'claude:laboral', label: 'Claude Code - Laboral', accountId: 'laboral', budget: allow }
  it('switches by itself only in automatic mode with a target', () => {
    expect(planFailover('automatic', 'limit', [target])).toEqual({ kind: 'switch', target })
    expect(planFailover('automatic', 'ceiling', [])).toEqual({ kind: 'ask' })
    expect(planFailover('ask', 'limit', [target])).toEqual({ kind: 'ask', target })
    expect(planFailover('off', 'limit', [target])).toEqual({ kind: 'none', reason: 'off' })
  })
  it('a manual request switches whatever the mode, when it can', () => {
    expect(planFailover('off', 'manual', [target])).toEqual({ kind: 'switch', target })
    expect(planFailover('ask', 'manual', [])).toEqual({ kind: 'none', reason: 'noTarget' })
  })
})

const facts: HandoffFacts = {
  goal: 'Add a retry to the payments client (ABC-12)',
  pullRequests: ['https://github.com/acme/pay/pull/7'],
  tickets: ['ABC-12'],
  filesTouched: ['src/client.ts', 'src/client.ts', 'test/client.test.ts'],
  commands: ['npm test', 'git status'],
  todos: [
    { text: 'Write the retry', status: 'completed' },
    { text: 'Cover the timeout case', status: 'in_progress' },
    { text: 'Update the README', status: 'pending' }
  ],
  exchanges: [
    { role: 'user', text: 'Add a retry to the payments client (ABC-12)' },
    { role: 'agent', text: 'Done: three attempts with backoff.' },
    { role: 'user', text: 'Now the timeout case' }
  ]
}

describe('buildHandoffBrief', () => {
  it('writes every section from the facts and the repository state', () => {
    const brief = buildHandoffBrief(facts, { sourceLabel: 'Claude - Personal', cwd: '/work/pay', git: { branch: 'feat/retry', dirtyFiles: ['src/client.ts'] } })
    expect(brief).toContain('# Hand-off from Claude - Personal')
    expect(brief).toContain('in `/work/pay`')
    expect(brief).toContain('## Goal\nAdd a retry to the payments client (ABC-12)')
    expect(brief).toContain('- Ticket ABC-12\n- https://github.com/acme/pay/pull/7')
    expect(brief).toContain('- Branch: `feat/retry`\n- Uncommitted changes: `src/client.ts`')
    expect(brief).toContain('## Files touched\n- `src/client.ts`\n- `test/client.test.ts`\n')
    expect(brief).toContain('- `npm test`')
    expect(brief).toContain('- [ ] Cover the timeout case (in progress)\n- [ ] Update the README')
    expect(brief).not.toContain('Write the retry')
    expect(brief).toContain('**User:** Now the timeout case')
    expect(brief.trimEnd().endsWith('Tell me what you plan to do before large changes.')).toBe(true)
  })

  it('stays inside the budget, keeping the newest exchanges', () => {
    const long: HandoffFacts = { ...facts, exchanges: Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'agent' : 'user', text: `message ${i} ${'x'.repeat(900)}` }) as const) }
    const brief = buildHandoffBrief(long, { sourceLabel: 'Claude', cwd: '/w', maxChars: 4_000, exchanges: 40 })
    expect(brief.length).toBeLessThanOrEqual(4_000)
    expect(brief).toContain('message 39')
    expect(brief).not.toContain('message 0 ')
  })

  it('cuts an oversized fixed part and still ends with the next step', () => {
    const brief = buildHandoffBrief({ ...EMPTY_FACTS, goal: 'g'.repeat(5_000) }, { sourceLabel: 'Codex', cwd: '/w', maxChars: 600 })
    expect(brief.length).toBeLessThanOrEqual(600)
    expect(brief).toContain('## Next step')
  })

  it('uses the agent-written summary instead of the exchanges, and notes a clean tree', () => {
    const brief = buildHandoffBrief(facts, { sourceLabel: 'Claude', cwd: '/w', summary: '## Goal\nRetry.', git: { branch: null, dirtyFiles: [] } })
    expect(brief).toContain('## Summary by Claude\n## Goal\nRetry.')
    expect(brief).not.toContain('## Last exchanges')
    expect(brief).toContain('- No uncommitted changes')
  })

  it('wraps commands holding backticks safely', () => {
    const brief = buildHandoffBrief({ ...EMPTY_FACTS, commands: ['echo `date`'] }, { sourceLabel: 'A', cwd: '/w' })
    expect(brief).toContain('- ``echo `date```')
  })
})

describe('factsFromHistory', () => {
  it('takes the goal, files, commands and exchanges from replayed messages and the monitor', () => {
    const f = factsFromHistory(
      [
        { kind: 'user', text: 'Fix the login' },
        { kind: 'tool', id: '1', title: 'Edited auth.ts', detail: '/w/auth.ts' },
        { kind: 'tool', id: '2', title: 'Ran the tests', detail: '$ npm test' },
        { kind: 'tool', id: '3', title: 'Read x.ts', detail: '/w/x.ts' },
        { kind: 'agent', text: 'Fixed.' },
        { kind: 'user', text: '   ' }
      ],
      { title: 'Login fix', pullRequests: ['https://x/pull/1'], ticketKeys: ['ABC-1'], toolCalls: [{ id: 't', title: 'Edited y', kind: 'edit', detail: '/w/y.ts' }] }
    )
    expect(f).toMatchObject({
      title: 'Login fix',
      goal: 'Fix the login',
      pullRequests: ['https://x/pull/1'],
      tickets: ['ABC-1'],
      filesTouched: ['/w/auth.ts', '/w/y.ts'],
      commands: ['npm test'],
      exchanges: [
        { role: 'user', text: 'Fix the login' },
        { role: 'agent', text: 'Fixed.' }
      ]
    })
  })
})

describe('handoffTargets', () => {
  it('offers app-mode agents other than the source, and no other Claude account for a Claude session', () => {
    const { p, candidates } = setup([personal, laboral, kiroWork], ['codex'])
    const fromClaude = handoffTargets(p, candidates, { agentId: 'claude', accountId: 'personal', family: 'claude' }).map((e) => e.key)
    expect(fromClaude[0]).toBe('codex')
    expect(fromClaude).toContain('kiro:kiro-work')
    expect(fromClaude.some((k) => k.startsWith('claude'))).toBe(false)
    expect(fromClaude).not.toContain('shell')
    const fromKiro = handoffTargets(p, candidates, { agentId: 'kiro', accountId: 'kiro-work', family: 'kiro' }).map((e) => e.key)
    expect(fromKiro).toContain('claude:personal')
    expect(fromKiro).not.toContain('kiro:kiro-work')
  })
})

describe('placeBeside', () => {
  const member = (key: string): GroupMember => ({ key, title: key, agentKey: 'codex', cwd: '/w' })
  it('puts the new session right after its source inside the source group', () => {
    let s: SessionGroups = createGroup(EMPTY_SESSION_GROUPS, 'g', 'Work', member('a'))
    s = { ...s, groups: s.groups.map((g) => ({ ...g, members: [...g.members, member('b')] })) }
    expect(placeBeside(s, member('n'), 'a').groups[0]!.members.map((m) => m.key)).toEqual(['a', 'n', 'b'])
  })
  it('puts it after an ungrouped source at the top level, and leaves unplaced sources alone', () => {
    const s: SessionGroups = { groups: [], top: [{ kind: 'session', key: 'a' }, { kind: 'session', key: 'b' }] }
    expect(placeBeside(s, member('n'), 'a').top).toEqual([{ kind: 'session', key: 'a' }, { kind: 'session', key: 'n' }, { kind: 'session', key: 'b' }])
    expect(placeBeside(s, member('n'), 'zzz')).toBe(s)
    expect(placeBeside(s, member('a'), 'a')).toBe(s)
  })
})
