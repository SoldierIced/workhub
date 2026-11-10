import { describe, expect, it } from 'vitest'
import { claudeOptionsFromProbe } from '../src/agent-claude-native'

describe('the models Claude Code reports before a session', () => {
  it('reads each model by its value, with its name and description', () => {
    const raw = {
      ok: true,
      models: [
        { value: 'fable', displayName: 'Fable 5.2', description: 'Most capable', supportedEffortLevels: ['low', 'max'] },
        { value: 'claude-opus-4-6', displayName: '' },
        { displayName: 'no value' }
      ],
      commands: [{ name: 'model' }]
    }
    expect(claudeOptionsFromProbe(raw)).toEqual({
      models: [
        { id: 'fable', name: 'Fable 5.2', description: 'Most capable' },
        { id: 'claude-opus-4-6', name: 'claude-opus-4-6' }
      ]
    })
  })

  it('fails on an error, a missing answer or an empty list, so the last reading stays', () => {
    expect(() => claudeOptionsFromProbe({ ok: false, error: 'not logged in' })).toThrow('not logged in')
    expect(() => claudeOptionsFromProbe(null)).toThrow()
    expect(() => claudeOptionsFromProbe({ ok: true, models: [] })).toThrow('no models')
  })
})
