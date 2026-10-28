import { describe, expect, it } from 'vitest'
import type { EffectiveAgent } from '@workhub/core'
import { quickSessionPlan } from '../src/renderer/lib/quickSession'

const HOME = '/Users/ana'
const agent = (key: string, label: string): EffectiveAgent => ({ key, label, account: null, agent: { id: key.split(':')[0]! } as EffectiveAgent['agent'] })
const claudeWork = agent('claude:work', 'Claude Laboral')
const codex = agent('codex', 'Codex')
const agents = [codex, claudeWork]

describe('quickSessionPlan', () => {
  it("starts the profile's preferred agent in its default folder", () => {
    const plan = quickSessionPlan({ preferredAgents: ['claude:work'], folders: ['~/wayni', '~/libs'], defaultFolder: '~/libs' }, agents, HOME)
    expect(plan).toEqual({ agentKey: 'claude:work', agentLabel: 'Claude Laboral', cwd: '/Users/ana/libs' })
  })

  it('uses the first folder when no default folder is set', () => {
    expect(quickSessionPlan({ folders: ['~/Desktop/proyectos'] }, agents, HOME)?.cwd).toBe('/Users/ana/Desktop/proyectos')
  })

  it('uses the home folder for a profile without folders, or no profile', () => {
    expect(quickSessionPlan({}, agents, HOME)?.cwd).toBe(HOME)
    expect(quickSessionPlan(undefined, agents, HOME)?.cwd).toBe(HOME)
  })

  it('takes the asked agent (a per-agent menu item) over the preferred one', () => {
    expect(quickSessionPlan({ preferredAgents: ['claude:work'] }, agents, HOME, 'codex')?.agentKey).toBe('codex')
  })

  it('has no plan without an agent or a folder (the dialog opens instead)', () => {
    expect(quickSessionPlan({ folders: ['~/a'] }, [], HOME)).toBeNull()
    expect(quickSessionPlan({ folders: ['~/a'] }, agents, HOME, 'missing')).toBeNull()
    expect(quickSessionPlan({}, agents, undefined)).toBeNull()
  })
})
