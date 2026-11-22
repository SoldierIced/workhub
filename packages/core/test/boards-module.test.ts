import { describe, expect, it } from 'vitest'
import { CONFIG_VERSION, NO_MODULES, OFFERED_MODULES, parseConfig } from '../src'

describe('the boards module', () => {
  it('is offered and off by default', () => {
    expect(OFFERED_MODULES).toContain('boards')
    expect(NO_MODULES.boards).toBe(false)
  })

  it('reads as off in a config saved before it existed', () => {
    const modules = { flows: false, health: true, chatWatcher: false, automations: false, flowMaps: false, planner: false }
    const old = parseConfig({ version: CONFIG_VERSION, profiles: [{ id: 'p', name: 'P', modules }] })
    expect(old.profiles[0]?.modules).toEqual({ ...modules, boards: false })
    expect(parseConfig({ version: CONFIG_VERSION, profiles: [{ id: 'p', name: 'P' }] }).profiles[0]?.modules.boards).toBe(false)
  })
})
