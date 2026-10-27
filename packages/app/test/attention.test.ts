import { beforeEach, describe, expect, it } from 'vitest'
import { NO_CAPABILITIES, type AgentEvent, type SessionState } from '@workhub/core'
import type { SessionView } from '../src/shared/api'
import { containsBell } from '../src/renderer/lib/attention'
import { listSessions } from '../src/renderer/lib/sessionGroups'
import { awaitingAnswer, getSessions, onAttention, onChanged, onEvent, setViewing, type SessionData } from '../src/renderer/store'

let counter = 0
function view(id: string, state: SessionState, over: Partial<SessionView> = {}): SessionView {
  return {
    id,
    identity: `identity-${id}`,
    agentId: 'claude',
    accountId: null,
    profileId: null,
    cwd: '/tmp/demo',
    state,
    permissionMode: null,
    startedAt: ++counter,
    label: 'Claude',
    agentName: 'Claude',
    adapter: 'native',
    capabilities: NO_CAPABILITIES,
    screens: [],
    modes: ['app'],
    mode: 'app',
    shellRunning: false,
    controls: false,
    ...over
  }
}

const data = (v: SessionView): SessionData => ({ view: v, items: [], monitor: {} })

describe('bell detection', () => {
  it('sees a bell and ignores the one that ends a terminal title', () => {
    expect(containsBell('done\u0007')).toBe(true)
    expect(containsBell('\u001b]0;user@host: ~\u0007prompt $ ')).toBe(false)
    expect(containsBell('\u001b]2;title\u001b\\prompt')).toBe(false)
    expect(containsBell('\u001b]0;title\u0007\u0007')).toBe(true)
    expect(containsBell('plain output')).toBe(false)
  })
})

describe('one entry per identity', () => {
  it('lists a reopened session once, preferring the open one over the stopped one', () => {
    const old = data(view('old', 'stopped', { identity: 'same' }))
    const reopened = data(view('new', 'ready', { identity: 'same' }))
    const other = data(view('other', 'ready'))
    const listed = listSessions([old, other, reopened])
    expect(listed.map((s) => s.data.view.id)).toEqual(['new', 'other'])
    expect(listed[0]!.key).toBe('same')
  })

  it('keys by the agent session id when there is one', () => {
    const s = data(view('a', 'ready', { agentSessionId: 'agent-1', identity: 'wh-1' }))
    expect(listSessions([s])[0]!.key).toBe('agent-1')
  })
})

describe('unseen flag in the store', () => {
  const seen: [string, string][] = []
  beforeEach(() => {
    setViewing(null)
    seen.length = 0
  })
  onAttention((id, kind) => seen.push([id, kind]))

  it('flags a finished turn while the session is off screen and clears it when it is viewed', () => {
    const id = 'turn'
    onChanged(view(id, 'ready'))
    onChanged(view(id, 'busy'))
    expect(getSessions()[id]!.unseen).toBeUndefined()
    onChanged(view(id, 'ready'))
    expect(getSessions()[id]!.unseen).toBe('replied')
    expect(seen).toEqual([[id, 'replied']])
    setViewing(id)
    expect(getSessions()[id]!.unseen).toBeUndefined()
  })

  it('flags nothing while the session is the one on screen', () => {
    const id = 'watched'
    onChanged(view(id, 'ready'))
    setViewing(id)
    onChanged(view(id, 'busy'))
    onChanged(view(id, 'ready'))
    expect(getSessions()[id]!.unseen).toBeUndefined()
    expect(seen).toEqual([])
  })

  it('flags a permission request as needing an answer and an error over a reply', () => {
    const id = 'ask'
    onChanged(view(id, 'busy'))
    const request: AgentEvent = { sessionId: id, type: 'permission', requestId: 'r1', title: 'Run ls?', options: [] }
    onEvent(request)
    expect(getSessions()[id]!.unseen).toBe('needsAnswer')
    expect(awaitingAnswer(getSessions()[id]!)).toBe(true)
    onChanged(view(id, 'ready'))
    expect(getSessions()[id]!.unseen).toBe('needsAnswer')
    onChanged(view(id, 'error'))
    expect(getSessions()[id]!.unseen).toBe('error')
  })

  it('does not flag a session that stops on purpose or only starts', () => {
    const id = 'quiet'
    onChanged(view(id, 'starting'))
    onChanged(view(id, 'ready'))
    onChanged(view(id, 'stopped'))
    expect(getSessions()[id]!.unseen).toBeUndefined()
  })

  it('treats the bell of a terminal agent as a reply, but not the shell next to it', () => {
    const id = 'bell'
    onChanged(view(id, 'ready'))
    onEvent({ sessionId: `${id}:shell`, type: 'output', data: 'x\u0007' })
    expect(getSessions()[id]!.unseen).toBeUndefined()
    onEvent({ sessionId: `${id}:console`, type: 'output', data: '\u001b]0;t\u0007' })
    expect(getSessions()[id]!.unseen).toBeUndefined()
    onEvent({ sessionId: `${id}:console`, type: 'output', data: 'done\u0007' })
    expect(getSessions()[id]!.unseen).toBe('replied')
  })
})
