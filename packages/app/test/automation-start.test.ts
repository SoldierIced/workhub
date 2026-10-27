import { describe, expect, it } from 'vitest'
import { emptyConfig, newAutomation, parseConfig, type AutomationDefinition, type ConfigurationService } from '@workhub/core'
import { AutomationService } from '../src/main/automations'
import type { StartSessionInput } from '../src/shared/api'

function setup(def: AutomationDefinition) {
  const started: StartSessionInput[] = []
  const config = { ...emptyConfig(), automations: [def] }
  const service = new AutomationService({
    configuration: { current: async () => config } as unknown as ConfigurationService,
    driver: { list: () => [], deliver: async () => undefined, interrupt: async () => undefined, stop: async () => undefined, forget: async () => undefined, setViewing: () => undefined } as never,
    startSession: async (input) => {
      started.push(input)
      throw new Error('stop here')
    },
    watcher: { link: () => undefined, renameOwner: () => undefined, transferThreads: () => undefined, listeningThreads: () => [] } as never,
    state: { load: (empty: unknown) => empty, save: () => undefined, flush: () => undefined } as never,
    home: '/tmp',
    usage: () => [],
    emit: () => undefined,
    configChanged: () => undefined,
    notice: () => undefined
  })
  return { service, started }
}

describe('automation session start', () => {
  it('starts its session with the model, effort and permission mode of the automation', async () => {
    const { service, started } = setup(newAutomation('a1', { agentKey: 'claude', folder: '/tmp', model: 'haiku', effort: 'high', permissionMode: 'acceptEdits' }))
    await service.start()
    await service.runNow('a1')
    service.stop()
    expect(started[0]).toMatchObject({ agentKey: 'claude', cwd: '/tmp', model: 'haiku', effort: 'high', modeId: 'acceptEdits' })
  })

  it('leaves them out when the automation sets none', async () => {
    const { service, started } = setup(newAutomation('a2', { folder: '/tmp' }))
    await service.start()
    await service.runNow('a2')
    service.stop()
    expect(started[0]).toBeDefined()
    expect(started[0]).not.toHaveProperty('effort')
    expect(started[0]).not.toHaveProperty('modeId')
    expect(started[0]).not.toHaveProperty('model')
  })
})

describe('automation config', () => {
  it('loads an old automation without the new fields and keeps them when set', () => {
    const base = { id: 'a', name: 'A', agentKey: 'claude' }
    const old = parseConfig({ version: 6, connections: [], agents: [], accounts: [], profiles: [], automations: [base] })
    expect(old.automations?.[0]).not.toHaveProperty('effort')
    const set = parseConfig({ version: 6, connections: [], agents: [], accounts: [], profiles: [], automations: [{ ...base, model: 'm', effort: 'max', permissionMode: 'plan' }] })
    expect(set.automations?.[0]).toMatchObject({ model: 'm', effort: 'max', permissionMode: 'plan' })
  })
})
