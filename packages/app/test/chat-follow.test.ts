import { describe, expect, it } from 'vitest'
import { followLog, isAtBottom, lastPromptId } from '../src/renderer/lib/chatScroll'
import { sessionModelName, sessionPermissionName } from '../src/renderer/lib/sessionHeader'
import { translate } from '../src/renderer/i18n/translate'

const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate('en', key, params)
const items = (...kinds: string[]) => kinds.map((kind, id) => ({ id, kind }))

describe('followLog', () => {
  it('follows new output while the reader is at the bottom', () => {
    const before = items('user', 'assistant')
    const mark = { lastPromptId: lastPromptId(before), queued: 0 }
    expect(followLog(mark, items('user', 'assistant', 'tool'), 0, true).follow).toBe(true)
  })

  it('leaves the scroll alone when the reader scrolled up and the agent keeps writing', () => {
    const before = items('user', 'assistant')
    const mark = { lastPromptId: lastPromptId(before), queued: 0 }
    expect(followLog(mark, items('user', 'assistant', 'tool', 'assistant'), 0, false).follow).toBe(false)
  })

  it('jumps to the bottom when the reader sends or queues a prompt, even scrolled up', () => {
    const before = items('user', 'assistant')
    const mark = { lastPromptId: lastPromptId(before), queued: 0 }
    expect(followLog(mark, items('user', 'assistant', 'user'), 0, false).follow).toBe(true)
    expect(followLog(mark, before, 1, false).follow).toBe(true)
    // A queued prompt leaving the queue is not the reader acting.
    expect(followLog({ ...mark, queued: 2 }, before, 1, false).follow).toBe(false)
  })

  it('measures the bottom with some slack', () => {
    expect(isAtBottom({ scrollHeight: 1000, scrollTop: 590, clientHeight: 400 })).toBe(true)
    expect(isAtBottom({ scrollHeight: 1000, scrollTop: 300, clientHeight: 400 })).toBe(false)
  })
})

describe('session facts', () => {
  it('names the picked model, else the one the agent reported, else the default', () => {
    expect(sessionModelName({ models: [{ id: 'opus', name: 'Opus' }], currentModelId: 'opus' }, 'claude-opus-x', t)).toBe('Opus')
    expect(sessionModelName({ currentModelId: 'gpt-5' }, undefined, t)).toBe('gpt-5')
    expect(sessionModelName({}, 'claude-sonnet-x', t)).toBe('claude-sonnet-x')
    expect(sessionModelName({ currentModelId: 'opus', modelIgnored: true }, 'claude-sonnet-x', t)).toBe('claude-sonnet-x')
    expect(sessionModelName({}, undefined, t)).toBe('Default model')
  })

  it('names the permission mode, or says it is pending or unknown', () => {
    expect(sessionPermissionName({ permissionMode: { id: 'custom', label: 'Ask every time' }, state: 'ready' }, t)).toBe('Ask every time')
    expect(sessionPermissionName({ permissionMode: null, state: 'starting' }, t)).toBe('pending')
    expect(sessionPermissionName({ permissionMode: null, state: 'ready' }, t)).toBe('unknown')
  })
})
