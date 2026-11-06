import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyConfig, NO_MODULES, resolveEffectiveAgents, type AgentAccount, type Profile, type Result, type WorkhubConfig } from '@workhub/core'
import type { AccountUsage, ConfigSnapshot } from '../src/shared/api'

/** Rendered on the server (no DOM): the controls are stand-ins that record their props, found by their accessible name. */
type Recorded = Record<string, unknown> & { 'aria-label'?: string; label?: string }
const controls: Recorded[] = []
vi.mock('../src/renderer/components/atoms', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/renderer/components/atoms')>()
  const record = (tag: string) =>
    function Recording(props: Recorded & { children?: ReactNode }) {
      controls.push(props)
      return createElement(tag, { 'aria-label': props['aria-label'] ?? props.label }, props.children as ReactNode)
    }
  return { ...actual, Switch: record('button'), IconButton: record('button'), Select: record('select') }
})

import { TooltipProvider } from '../src/renderer/components/atoms'
import { ProfileAgentsTab } from '../src/renderer/screens/settings/ProfileAgentsTab'
import { newSessionAgentOptions, ORDER_AGENTS_OPTION, profileAgentsTarget } from '../src/renderer/lib/profileAgents'
import { translate } from '../src/renderer/i18n/translate'

const personal: AgentAccount = { id: 'personal', agentId: 'claude', name: 'Personal', configDir: '/tmp/example/claude-personal' }
const work: AgentAccount = { id: 'work', agentId: 'claude', name: 'Work', configDir: '/tmp/example/claude-work' }
const profile = (over: Partial<Profile>): Profile => ({ id: 'acme', name: 'Acme', connections: {}, accountIds: [], modules: { ...NO_MODULES }, agentIds: ['claude', 'shell'], ...over })

const makeConfig = (): WorkhubConfig => ({
  ...emptyConfig(),
  accounts: [personal, work],
  activeProfileId: 'acme',
  profiles: [profile({ accountIds: ['personal', 'work'] }), profile({ id: 'side', name: 'Side project', accountIds: ['personal', 'work'], preferredAgents: ['claude:work', 'claude:personal', 'shell'] })]
})

let stored: WorkhubConfig
const saveProfile = vi.fn(async (p: Profile): Promise<Result<WorkhubConfig>> => ({ ok: true, value: { ...stored, profiles: stored.profiles.map((x) => (x.id === p.id ? p : x)) } }) as never)
const run = vi.fn(async (op: () => Promise<Result<WorkhubConfig>>) => (await op()).ok)

beforeEach(() => {
  controls.length = 0
  saveProfile.mockClear()
  stored = makeConfig()
  vi.stubGlobal('window', { hub: { config: { saveProfile, get: async () => ({ config: stored }) }, usage: { get: async () => [], onChanged: () => () => {} } } })
})
afterEach(() => vi.unstubAllGlobals())

const snapshot = (config = stored): ConfigSnapshot => ({ config, issues: [], agents: [], providers: [], connectionsWithSecret: [], dataDir: '/tmp/example' })
const render = (profileId: string) => renderToStaticMarkup(createElement(TooltipProvider, null, createElement(ProfileAgentsTab, { snap: snapshot(), run, profileId })))
const control = (name: string) => {
  const found = controls.find((c) => c['aria-label'] === name || c.label === name)
  if (!found) throw new Error(`no control "${name}"; have: ${controls.map((c) => c['aria-label'] ?? c.label).join(' | ')}`)
  return found
}
const saved = () => saveProfile.mock.calls.at(-1)![0]

describe('ProfileAgentsTab', () => {
  it('lists the rows in the profile order with the default first', () => {
    const html = render('side')
    expect(html).toContain('Agents this profile offers, in order')
    expect(html.indexOf('Claude Code · Work')).toBeLessThan(html.indexOf('Claude Code · Personal'))
    expect(html).toContain('not offered in this profile')
    expect(html).toContain('Default = the first offered row.')
    expect(html).toContain('(here: Work → Personal)')
  })

  it('writes the Offer switch to the profile it shows, not the active one', async () => {
    render('side')
    ;(control('Offer Claude Code · Personal').onChange as (on: boolean) => void)(false)
    await vi.waitFor(() => expect(saveProfile).toHaveBeenCalledTimes(1))
    expect(saved().id).toBe('side')
    expect(saved().accountIds).toEqual(['work'])
    expect(saved().preferredAgents).toEqual(['claude:work', 'shell'])
  })

  it('rewrites preferredAgents with the arrows', async () => {
    render('side')
    expect(control('Move Claude Code · Work up').disabled).toBe(true)
    ;(control('Move Claude Code · Personal up').onClick as () => void)()
    await vi.waitFor(() => expect(saveProfile).toHaveBeenCalledTimes(1))
    expect(saved()).toMatchObject({ id: 'side', preferredAgents: ['claude:personal', 'claude:work', 'shell'] })
  })

  it('writes the account switch mode, and disables it with a single Claude account', async () => {
    render('side')
    ;(control('If a Claude account reaches its limit').onChange as (v: string) => void)('automatic')
    await vi.waitFor(() => expect(saveProfile).toHaveBeenCalledTimes(1))
    expect(saved()).toMatchObject({ id: 'side', accountFailover: 'automatic' })

    controls.length = 0
    stored = { ...stored, profiles: [profile({ accountIds: ['work'] })] }
    const html = render('acme')
    expect(html).toContain('Work is the only Claude account offered: nothing to switch to')
    expect(control('If a Claude account reaches its limit').disabled).toBe(true)
  })
})

describe('New session agent options', () => {
  const t = (key: Parameters<typeof translate>[1], vars: Record<string, string | number>) => translate('en', key, vars)
  const reads: AccountUsage[] = [{ agentId: 'claude', key: 'claude:personal', accountId: 'personal', name: 'Personal', windows: [{ window: '5h', percent: 33.6 }], at: 1, budget: { action: 'allow' } as AccountUsage['budget'] }]

  it('follows the profile order, marks the default, shows usage and ends with the order item', () => {
    const config = makeConfig()
    const side = config.profiles[1]!
    const options = newSessionAgentOptions({ agents: resolveEffectiveAgents(config, 'side'), preferredAgents: side.preferredAgents, reads, labelOf: (a) => a.label, profile: side, t, now: 0 })
    expect(options.map((o) => o.label)).toEqual(['Claude Code · Work (default)', 'Claude Code · Personal · 34 %', 'Shell', 'Order and pick agents of Side project…'])
    expect(options.at(-1)!.value).toBe(ORDER_AGENTS_OPTION)
    expect(profileAgentsTarget('side')).toBe('profiles/side/agents')
  })

  it('has no order item without a profile', () => {
    const config = makeConfig()
    const options = newSessionAgentOptions({ agents: resolveEffectiveAgents(config, 'acme'), preferredAgents: undefined, reads: [], labelOf: (a) => a.label, t })
    expect(options[0]!.label).toBe('Claude Code · Personal (default)')
    expect(options.some((o) => o.value === ORDER_AGENTS_OPTION)).toBe(false)
  })
})
