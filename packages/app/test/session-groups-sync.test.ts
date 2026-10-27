import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGroup, emptyConfig, renameGroup, type GroupMember, type SessionGroups } from '@workhub/core'
import type { ConfigSnapshot } from '../src/shared/api'
import { refreshConfig } from '../src/renderer/configStore'
import { updateGroups } from '../src/renderer/lib/sessionGroups'

const member = (key: string): GroupMember => ({ key, title: 'OpenCode', agentKey: 'opencode', cwd: '/tmp/demo' })

/** A fake main process: config.get answers what main holds now, saveSessionGroups stores it. */
function fakeMain(groups: SessionGroups) {
  const main = { groups }
  const snapshot = (): ConfigSnapshot => ({ config: { ...emptyConfig(), sessionGroups: main.groups } }) as unknown as ConfigSnapshot
  const saveSessionGroups = vi.fn(async (g: SessionGroups) => {
    main.groups = g
    return { ok: true, value: snapshot().config }
  })
  vi.stubGlobal('window', { hub: { config: { get: async () => snapshot(), saveSessionGroups } } })
  return { main, saveSessionGroups }
}

afterEach(() => vi.unstubAllGlobals())

describe('updateGroups', () => {
  it('applies a group edit on the config main has now, not on a stale copy', async () => {
    const { main, saveSessionGroups } = fakeMain(createGroup({ groups: [], top: [] }, 'g1', 'Work', member('provisional-1')))
    // The renderer loaded the config while the session still had its provisional id...
    await refreshConfig()
    // ...then the ACP agent reported its real id and main moved the group place on its own.
    main.groups = { ...main.groups, groups: main.groups.groups.map((g) => ({ ...g, members: g.members.map((m) => (m.key === 'provisional-1' ? { ...m, key: 'acp-real' } : m)) })) }

    await updateGroups((state) => renameGroup(state, 'g1', 'Renamed'), ['acp-real'])

    expect(saveSessionGroups).toHaveBeenCalledTimes(1)
    const saved = main.groups
    expect(saved.groups[0]).toMatchObject({ name: 'Renamed', members: [member('acp-real')] })
    expect(JSON.stringify(saved)).not.toContain('provisional-1')
  })
})
