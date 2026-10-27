import { describe, expect, it } from 'vitest'
import type { ConversationEntry } from '@workhub/core'
import { pathInsideFolder } from '../src/main/reveal'
import { applyEvent, type SessionData } from '../src/renderer/store'
import { backSubagent, closeSubagent, isLive, openSubagent, shortDuration, subagentOfCall, useOpenSubagent, visibleEntries } from '../src/renderer/lib/subagentView'

describe('pathInsideFolder', () => {
  it('accepts files inside the session folder only', () => {
    expect(pathInsideFolder('/repo', '/repo/src/a.ts')).toBe('/repo/src/a.ts')
    expect(pathInsideFolder('/repo', 'src/a.ts')).toBe('/repo/src/a.ts')
    expect(pathInsideFolder('/repo', '/repo/../etc/passwd')).toBeNull()
    expect(pathInsideFolder('/repo', '/repository/a.ts')).toBeNull()
    expect(pathInsideFolder('/repo', '/repo')).toBeNull()
    expect(pathInsideFolder('/repo', '')).toBeNull()
  })
})

describe('sub-agent view helpers', () => {
  const entries: ConversationEntry[] = Array.from({ length: 5 }, (_, i) => ({ kind: 'text', id: `e${i}`, text: String(i) }))

  it('shows the last page of entries and counts the hidden ones', () => {
    expect(visibleEntries(entries, 3)).toEqual({ hidden: 2, list: entries.slice(2) })
    expect(visibleEntries(entries, 10)).toEqual({ hidden: 0, list: entries })
  })

  it('formats short durations and tells live statuses', () => {
    expect(shortDuration(400)).toBe('1 s')
    expect(shortDuration(4_000)).toBe('4 s')
    expect(shortDuration(63_000)).toBe('1 min 3 s')
    expect(shortDuration(2 * 3_600_000 + 5 * 60_000)).toBe('2 h 5 min')
    expect(isLive('running')).toBe(true)
    expect(isLive('completed')).toBe(false)
  })

  it('finds the sub-agent of a parent call and stacks nested ones', () => {
    expect(subagentOfCall([{ id: 'a1', toolUseId: 't1' }], 't1')?.id).toBe('a1')
    expect(subagentOfCall([{ id: 'a1' }], 't1')).toBeUndefined()
    expect(typeof useOpenSubagent).toBe('function')
    openSubagent('s', 'a1')
    openSubagent('s', 'a2', true)
    backSubagent()
    closeSubagent()
  })
})

describe('store tool views', () => {
  it('keeps the view of a call and adds its result when it ends', () => {
    const empty = { view: {}, items: [], monitor: {} } as unknown as SessionData
    let id = 0
    const next = () => ++id
    let s = applyEvent(empty, { sessionId: 's', type: 'tool', toolCallId: 't', title: 'npm test', status: 'in_progress', view: { kind: 'command', command: 'npm test' } }, next)
    s = applyEvent(s, { sessionId: 's', type: 'tool', toolCallId: 't', status: 'failed', result: { text: 'boom', exitCode: 1 } }, next)
    expect(s.items).toEqual([
      expect.objectContaining({ kind: 'tool', status: 'failed', view: { kind: 'command', command: 'npm test' }, result: { text: 'boom', exitCode: 1 } })
    ])
  })
})
