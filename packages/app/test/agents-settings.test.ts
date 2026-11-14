import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  accountAgentId,
  BUILTIN_AGENTS,
  DEFAULT_USAGE_BUDGET,
  emptyConfig,
  orderAgents,
  resolveEffectiveAgents,
  setCeiling,
  NO_MODULES,
  type AgentAccount,
  type PlanUsageWindow,
  type Profile,
  type Result,
  type WorkhubConfig
} from '@workhub/core'
import type { AccountUsage, ConfigSnapshot } from '../src/shared/api'

/**
 * The render tests run on the server (no DOM), so the controls are swapped for stand-ins that
 * record their props: a test finds a control by its accessible name or test id and calls its handler.
 */
type Recorded = Record<string, unknown> & { 'aria-label'?: string; 'data-testid'?: string }
const controls: Recorded[] = []
vi.mock('../src/renderer/components/atoms', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/renderer/components/atoms')>()
  const record = (tag: string) =>
    function Recording(props: Recorded & { children?: ReactNode }) {
      controls.push(props)
      return createElement(tag, { 'aria-label': props['aria-label'], 'data-testid': props['data-testid'] }, props.children as ReactNode)
    }
  return { ...actual, Switch: record('button'), Button: record('button'), Input: record('input'), Select: record('select') }
})

import { TooltipProvider } from '../src/renderer/components/atoms'
import { AccountForm, AccountsSection, offeringText, ordinal, signInLosses } from '../src/renderer/screens/settings/AccountsSection'
import { AGENTS_INDEX } from '../src/renderer/screens/settings/agents-index'
import { accountOfferings, adoptSignIn, initialOffers, mostSpentWindow, offerChanges, storedOffers, withAccountInProfile } from '../src/renderer/lib/accountDefaults'
import { translate } from '../src/renderer/i18n/translate'
import { DemoUsageProvider } from '../src/main/agent-usage'
import { accountListItems, agentDirectory, agentEngine, signInEntries } from '../src/renderer/lib/agents'
import { agentUsageSections, budgetWindows, sessionBudget, shortReset, usageTone } from '../src/renderer/lib/agent-usage'
import { en } from '../src/renderer/i18n/en'

const NOW = new Date(2026, 9, 27, 12, 0).getTime()
const HOUR = 3_600_000
const personal: AgentAccount = { id: 'personal', agentId: 'claude', name: 'Claude Personal', configDir: '/tmp/claude-personal' }
const work: AgentAccount = { id: 'work', agentId: 'claude', name: 'Claude laboral', configDir: '/tmp/claude-work', defaultModel: 'opus' }
const owner = (id: string) => {
  const agent = BUILTIN_AGENTS.find((a) => a.id === id)
  return agent ? accountAgentId(agent) : id
}
const read = (agentId: string, accountId: string | null, windows: PlanUsageWindow[], error?: string): AccountUsage => ({
  agentId,
  key: accountId ? `${agentId}:${accountId}` : agentId,
  accountId,
  name: '',
  windows,
  at: NOW,
  budget: { action: 'allow' },
  ...(error ? { error } : {})
})

describe('Settings → Agents directory', () => {
  const config: WorkhubConfig = {
    ...emptyConfig(),
    accounts: [personal, work],
    profiles: [{ id: 'p', name: 'P', connections: {}, accountIds: ['personal', 'work'], modules: { flows: false, health: false, chatWatcher: false, automations: false, flowMaps: false, planner: false } }]
  }

  it('explains the four Claude entries: two accounts, each through two engines', () => {
    const claude = resolveEffectiveAgents(config, 'p').filter((e) => accountAgentId(e.agent) === 'claude')
    expect(claude.map((e) => e.key)).toEqual(['claude:personal', 'claude:work', 'claude-acp:personal', 'claude-acp:work'])
    expect(claude.map((e) => agentEngine(e.agent))).toEqual(['sdk', 'sdk', 'acp', 'acp'])
    // Each one is still distinct once the engine is shown next to the account.
    expect(new Set(claude.map((e) => `${e.account?.name} ${agentEngine(e.agent)}`)).size).toBe(4)
  })

  it('lists every agent, with Kiro and the Claude ACP engine right after Claude, and the sign-in state of each account', () => {
    const reads = [read('claude', 'personal', [{ window: '5h', percent: 10 }]), read('claude', 'work', [], 'Sign-in expired'), read('kiro', null, [{ window: 'monthly', percent: 25 }])]
    const dir = agentDirectory(BUILTIN_AGENTS, config.accounts, reads, { claude: true, 'claude-acp': true, kiro: true, codex: false })
    expect(dir.map((e) => e.agent.id)).toEqual(['claude', 'claude-acp', 'kiro', 'opencode', 'codex', 'gemini', 'shell'])
    const claude = dir[0]!
    expect(claude.accounts.map((a) => [a.account.id, a.login])).toEqual([
      ['personal', { state: 'ok' }],
      ['work', { state: 'error', error: 'Sign-in expired' }]
    ])
    expect(dir[1]).toMatchObject({ engine: 'acp', sharesAccountsOf: { id: 'claude' }, accounts: [] })
    expect(dir.find((e) => e.agent.id === 'kiro')).toMatchObject({ engine: 'acp', installed: true, accounts: [], defaultLogin: { state: 'ok' } })
    expect(dir.find((e) => e.agent.id === 'codex')).toMatchObject({ installed: false, defaultLogin: { state: 'unknown' } })
    expect(agentDirectory(BUILTIN_AGENTS, [], [], null)[0]!.installed).toBeUndefined()
  })

  it('keeps the order list readable: preferred keys first', () => {
    const ordered = orderAgents(['claude:work', 'kiro'], resolveEffectiveAgents(config, 'p'))
    expect(ordered.slice(0, 2).map((e) => e.key)).toEqual(['claude:work', 'kiro'])
  })

  it('has the copy for every engine', () => {
    for (const k of ['sdk', 'acp', 'terminal']) {
      expect(en[`agents.engine.${k}` as keyof typeof en]).toBeTruthy()
      expect(en[`agents.engine.${k}Hint` as keyof typeof en]).toBeTruthy()
    }
  })
})

describe('Settings → Agents accounts list', () => {
  const kiroRead = read('kiro', null, [{ window: 'monthly', percent: 25, used: 2500, limit: 10000, plan: 'KIRO POWER' }])

  it('lists every agent that signs in, Kiro and Codex included, but not terminals or a second engine of Claude', () => {
    const entries = signInEntries(BUILTIN_AGENTS, [kiroRead, read('codex', null, [], 'not signed in')], { kiro: true, codex: false })
    expect(entries.map((e) => e.agent.id)).toEqual(['claude', 'kiro', 'opencode', 'codex', 'gemini'])
    const kiro = entries.find((e) => e.agent.id === 'kiro')!
    expect(kiro).toMatchObject({ id: 'sign-in:kiro', kind: 'onePerComputer', login: { state: 'ok' }, installed: true, plan: 'KIRO POWER' })
    expect(kiro.windows).toHaveLength(1)
    expect(entries.find((e) => e.agent.id === 'codex')).toMatchObject({ kind: 'folder', login: { state: 'error', error: 'not signed in' }, installed: false })
    expect(entries.find((e) => e.agent.id === 'claude')).toMatchObject({ kind: 'folder', login: { state: 'unknown' }, windows: [] })
    expect(entries.find((e) => e.agent.id === 'opencode')?.kind).toBe('generic')
    expect(signInEntries(BUILTIN_AGENTS, [], null)[0]?.installed).toBeUndefined()
  })

  it("puts each agent's sign-in before its accounts, and accounts of unknown agents last", () => {
    const orphan: AgentAccount = { id: 'gone', agentId: 'removed-agent', name: 'Gone' }
    const kiroWork: AgentAccount = { id: 'kiro-work', agentId: 'kiro', name: 'Kiro work' }
    const items = accountListItems(signInEntries(BUILTIN_AGENTS, [], null), [orphan, kiroWork, personal, work])
    expect(items.map((i) => i.id)).toEqual(['sign-in:claude', 'personal', 'work', 'sign-in:kiro', 'kiro-work', 'sign-in:opencode', 'sign-in:codex', 'sign-in:gemini', 'gone'])
    // A sign-in id can never be an account id (account ids have no ":").
    expect(items.filter((i) => i.kind === 'signIn').every((i) => i.id.includes(':'))).toBe(true)
  })
})

describe('session usage limit', () => {
  const reads = [read('claude', 'work', [{ window: 'weekly', percent: 85, resetsAt: NOW + HOUR }])]
  const budget = setCeiling(DEFAULT_USAGE_BUDGET, 'claude:work', 'weekly', 80)

  it("overrides the account's ceiling for this session and says so", () => {
    expect(sessionBudget({ agentId: 'claude', accountId: 'work' }, reads, budget, owner, NOW)).toMatchObject({ status: { action: 'block' }, fromSession: false })
    expect(sessionBudget({ agentId: 'claude', accountId: 'work' }, reads, budget, owner, NOW, { weekly: 95 })).toMatchObject({ status: { action: 'allow' } })
    expect(sessionBudget({ agentId: 'claude-acp', accountId: 'work' }, reads, DEFAULT_USAGE_BUDGET, owner, NOW, { weekly: 70 })).toMatchObject({
      status: { action: 'block', ceiling: 70 },
      fromSession: true
    })
  })
})

describe('compact usage card helpers', () => {
  const format = (at: number, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-GB', { ...o, hour12: false }).format(at)

  it('shows the time today, the weekday within a week, else the date', () => {
    expect(shortReset(new Date(2026, 9, 27, 18, 59).getTime(), NOW, format)).toBe('18:59')
    expect(shortReset(new Date(2026, 9, 29, 17, 59).getTime(), NOW, format)).toBe('Thu 17:59')
    expect(shortReset(new Date(2026, 10, 15).getTime(), NOW, format)).toBe('15 Nov')
  })

  it('keeps the colour thresholds', () => {
    expect(usageTone(50, undefined)).toBe('normal')
    expect(usageTone(76, undefined)).toBe('warning')
    expect(usageTone(91, undefined)).toBe('danger')
    expect(usageTone(56, 60)).toBe('warning')
    expect(usageTone(60, 60)).toBe('danger')
  })

  it('lists Kiro and Codex accounts with Claude, and budgets Kiro on its monthly credits', async () => {
    const kiro = await new DemoUsageProvider('kiro', () => NOW).read(undefined)
    expect(kiro[0]).toMatchObject({ window: 'monthly', used: expect.any(Number), limit: expect.any(Number) })
    const sections = agentUsageSections(
      [],
      [read('claude', 'personal', [{ window: '5h', percent: 10 }]), read('codex', null, [{ window: '5h', percent: 30 }]), read('kiro', null, kiro)],
      DEFAULT_USAGE_BUDGET,
      owner,
      NOW
    )
    expect(sections.map((s) => s.agentId)).toEqual(['claude', 'codex', 'kiro'])
    expect(budgetWindows(kiro, undefined, 'kiro')).toEqual(['monthly'])
  })
})

const profile = (id: string, name: string, over: Partial<Profile> = {}): Profile => ({ id, name, connections: {}, accountIds: [], modules: { ...NO_MODULES }, ...over })
const tEn = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) => translate('en', key, params)

describe('Settings → Agents: where each account is offered', () => {
  const config: WorkhubConfig = {
    ...emptyConfig(),
    accounts: [personal, work],
    profiles: [profile('acme', 'Acme web', { accountIds: ['personal', 'work'], preferredAgents: ['claude:work'] }), profile('side', 'Side project', { accountIds: ['personal'] })]
  }

  it('says in which profiles an account is offered and in which place, counting both engines of an account once', () => {
    expect(accountOfferings(config, 'claude', 'personal')).toEqual([
      { profileId: 'acme', profileName: 'Acme web', position: 2 },
      { profileId: 'side', profileName: 'Side project', position: 1 }
    ])
    expect(accountOfferings(config, 'claude', 'work')).toEqual([{ profileId: 'acme', profileName: 'Acme web', position: 1 }])
    expect(offeringText(accountOfferings(config, 'claude', 'personal'), tEn, 'en')).toBe('offered in Acme web (2nd), Side project (1st)')
    // Once a profile offers a Claude account, the sign-in of this computer is not offered there.
    expect(accountOfferings(config, 'claude', null)).toEqual([])
    expect(offeringText([], tEn, 'en')).toBe('not offered in any profile')
    // Kiro, with no account, is offered through its own sign-in, after the Claude accounts.
    expect(accountOfferings(config, 'kiro', null).map((o) => [o.profileId, o.position])).toEqual([
      ['acme', 3],
      ['side', 2]
    ])
  })

  it('words the places in each language', () => {
    expect([1, 2, 3, 4, 11, 22].map((n) => ordinal(n, 'en'))).toEqual(['1st', '2nd', '3rd', '4th', '11th', '22nd'])
    expect(ordinal(2, 'es')).toBe('2.º')
  })

  it('"Offer in profile" writes the profile\'s accountIds, and taking it out drops it from the order', () => {
    const stored = storedOffers(config, 'work')
    expect(stored).toEqual({ acme: true, side: false })
    const changes = offerChanges(stored, { acme: false, side: true })
    expect(changes).toEqual([
      { profileId: 'acme', on: false },
      { profileId: 'side', on: true }
    ])
    const acme = withAccountInProfile(config.profiles[0]!, 'work', false)
    expect(acme.accountIds).toEqual(['personal'])
    expect(acme.preferredAgents).toEqual([])
    expect(withAccountInProfile(config.profiles[1]!, 'work', true).accountIds).toEqual(['personal', 'work'])
  })

  it('a new account starts checked in the working profile, and that check is a change to write', () => {
    const opened = initialOffers(config, null, 'side')
    expect(opened).toEqual({ acme: false, side: true })
    // The stored state of a new account is "in no profile": the first save writes the check.
    expect(offerChanges(storedOffers(config, null), opened)).toEqual([{ profileId: 'side', on: true }])
  })

  it("warns which profiles lose the computer's own sign-in, and making it an account keeps its places", () => {
    const bare: WorkhubConfig = { ...emptyConfig(), profiles: [profile('acme', 'Acme web', { preferredAgents: ['claude', 'kiro'] }), profile('side', 'Side project')] }
    expect(signInLosses(bare, 'claude', { acme: true, side: false })).toEqual(['Acme web'])
    expect(signInLosses(config, 'claude', { acme: true, side: true })).toEqual([])
    const adopted = adoptSignIn(bare.profiles[0]!, ['claude', 'claude-acp'], 'personal')
    expect(adopted).toMatchObject({ accountIds: ['personal'], preferredAgents: ['claude:personal', 'kiro'] })
  })

  it('shows the most spent window with its cap', () => {
    expect(mostSpentWindow([{ window: '5h', percent: 82.4 }, { window: 'weekly', percent: 40 }], { '5h': 90 })).toEqual({ window: '5h', percent: 82, ceiling: 90 })
    expect(mostSpentWindow([], undefined)).toBeUndefined()
  })
})

describe('Settings → Agents section', () => {
  const saveAccount = vi.fn(async (_a: AgentAccount): Promise<Result<WorkhubConfig>> => ({ ok: true, value: emptyConfig() }) as never)
  const saveProfile = vi.fn(async (p: Profile): Promise<Result<WorkhubConfig>> => ({ ok: true, value: { ...emptyConfig(), profiles: [p] } }) as never)
  const saveOptions = vi.fn(async (): Promise<Result<WorkhubConfig>> => ({ ok: true, value: emptyConfig() }) as never)
  const run = vi.fn(async (op: () => Promise<Result<WorkhubConfig>>) => (await op()).ok)
  let stored: WorkhubConfig
  const snapshot = (config: WorkhubConfig): ConfigSnapshot => ({ config, issues: [], agents: [...BUILTIN_AGENTS], providers: [], connectionsWithSecret: [], dataDir: '/tmp/example' })

  beforeEach(() => {
    controls.length = 0
    saveAccount.mockClear()
    saveProfile.mockClear()
    stored = { ...emptyConfig(), accounts: [work], profiles: [profile('acme', 'Acme web', { accountIds: ['work'] }), profile('side', 'Side project')], activeProfileId: 'acme' }
    vi.stubGlobal('window', {
      hub: {
        config: { saveAccount, saveProfile, saveOptions, get: async () => ({ config: stored }), deleteAccount: async () => ({ ok: true }) },
        agents: { availability: async () => ({}), options: async () => ({ models: [], modes: [], source: 'none' }) },
        usage: { get: async () => [], onChanged: () => () => {} },
        accountEnv: { stored: async () => [], save: async () => {} },
        pickFolder: async () => null
      }
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  const control = (name: string) => {
    const found = controls.find((c) => c['aria-label'] === name || c['data-testid'] === name)
    if (!found) throw new Error(`no control "${name}"; have: ${controls.map((c) => c['aria-label'] ?? c['data-testid']).join(' | ')}`)
    return found
  }

  it('renders one card per agent with its sign-in row, its accounts and where each is offered', () => {
    const html = renderToStaticMarkup(createElement(TooltipProvider, null, createElement(AccountsSection, { snap: snapshot(stored), run })))
    expect(html.match(/data-testid="agents-card"/g)?.length).toBe(BUILTIN_AGENTS.filter((a) => !a.accountsOf).length)
    expect(html).toContain('data-account="work"')
    expect(html).toContain('offered in Acme web (1st)')
    expect(html).toContain('Sign-in of this computer')
    // Workhub's MCP server and skills for agents, at the end of the section.
    expect(html).toContain('Workhub tools for agents')
    expect(html).toContain('Give sessions the Workhub MCP server')
    // No "Use as default" on any row: the default is decided in each profile.
    expect(html).not.toContain('Use as default')
    // Kiro keeps one login per computer: it adds variants, not accounts.
    expect(html).toContain('one login per computer')
    control('Add variant · Kiro')
    control('Add account · Claude Code')
    // One reading switch per agent that has a usage reader; no warning margin any more.
    control('Show plan usage · Claude Code')
    control('Show credits left · Kiro')
    expect(html).not.toContain('Warning margin')
    for (const row of AGENTS_INDEX.filter((r) => r.id !== 'agents.missing')) expect(html).toContain(`data-setting-id="${row.id}"`)
  })

  it('a new account saved with "Offer in profile" checked is offered at once (no default needed)', async () => {
    const snap = snapshot(stored)
    renderToStaticMarkup(
      createElement(AccountForm, { snap, run, account: null, agentId: 'claude', preset: { name: 'Personal', configDir: '~/.claude' }, workingProfile: 'side', budget: DEFAULT_USAGE_BUDGET, read: undefined, onClose: () => {} })
    )
    control('Offer in Side project')
    await (control('accounts-editor-save').onClick as () => Promise<void>)()
    await new Promise((r) => setTimeout(r, 0))
    expect(saveAccount).toHaveBeenCalledWith({ id: 'personal', agentId: 'claude', name: 'Personal', configDir: '~/.claude' })
    expect(saveProfile).toHaveBeenCalledTimes(1)
    const savedProfile = saveProfile.mock.calls[0]![0]
    expect(savedProfile).toMatchObject({ id: 'side', accountIds: ['personal'] })
    const after: WorkhubConfig = { ...stored, accounts: [...stored.accounts, { id: 'personal', agentId: 'claude', name: 'Personal' }], profiles: [stored.profiles[0]!, savedProfile] }
    expect(offeringText(accountOfferings(after, 'claude', 'personal'), tEn, 'en')).toBe('offered in Side project (1st)')
  })

  it("offers in one click to make the computer's own Claude login an account, kept where it was offered", async () => {
    stored = { ...emptyConfig(), profiles: [profile('acme', 'Acme web', { preferredAgents: ['claude', 'kiro'] })], activeProfileId: 'acme' }
    const html = renderToStaticMarkup(
      createElement(AccountForm, { snap: snapshot(stored), run, account: null, agentId: 'claude', workingProfile: 'acme', budget: DEFAULT_USAGE_BUDGET, read: undefined, onClose: () => {} })
    )
    expect(html).toContain('the sign-in of this computer disappears from that profile (Acme web)')
    await (control('account-adopt-create').onClick as () => Promise<void>)()
    await new Promise((r) => setTimeout(r, 0))
    expect(saveAccount).toHaveBeenCalledWith({ id: 'personal', agentId: 'claude', name: 'Personal', configDir: '~/.claude' })
    expect(saveProfile.mock.calls[0]![0]).toMatchObject({ id: 'acme', accountIds: ['personal'], preferredAgents: ['claude:personal', 'kiro'] })
  })
})
