import { describe, expect, it } from 'vitest'
import { applyEvent, withCompaction, withTurnEnd, type SessionData } from '../src/renderer/store'

const empty = () => ({ view: {} as SessionData['view'], items: [], monitor: {} }) as unknown as SessionData
const counter = () => {
  let n = 0
  return () => ++n
}
const compactions = (s: SessionData) => s.items.filter((i) => i.kind === 'compaction')

describe('compaction in the chat', () => {
  it('shows a running divider that the boundary and the summary complete', () => {
    const next = counter()
    let s = withCompaction(empty(), { sessionId: 's', type: 'compaction', phase: 'started' }, next)
    // A repeated start while one runs adds nothing.
    s = withCompaction(s, { sessionId: 's', type: 'compaction', phase: 'started' }, next)
    expect(compactions(s)).toMatchObject([{ phase: 'running' }])
    s = withCompaction(s, { sessionId: 's', type: 'compaction', phase: 'done', trigger: 'manual', preTokens: 43_500 }, next)
    s = withCompaction(s, { sessionId: 's', type: 'compaction', phase: 'done', summary: 'What happened so far' }, next)
    expect(compactions(s)).toEqual([expect.objectContaining({ phase: 'done', trigger: 'manual', preTokens: 43_500, summary: 'What happened so far' })])
  })

  it('reports a failed compaction with its reason', () => {
    const next = counter()
    let s = withCompaction(empty(), { sessionId: 's', type: 'compaction', phase: 'started' }, next)
    s = withCompaction(s, { sessionId: 's', type: 'compaction', phase: 'failed', error: 'Not enough messages' }, next)
    expect(compactions(s)).toMatchObject([{ phase: 'failed', error: 'Not enough messages' }])
  })

  it('keeps an earlier compaction apart from a later one', () => {
    const next = counter()
    let s = withCompaction(empty(), { sessionId: 's', type: 'compaction', phase: 'done', trigger: 'auto', summary: 'first' }, next)
    s = applyEvent(s, { sessionId: 's', type: 'message', role: 'agent', text: 'hello' }, next)
    s = withCompaction(s, { sessionId: 's', type: 'compaction', phase: 'done', trigger: 'manual' }, next)
    expect(compactions(s)).toMatchObject([{ trigger: 'auto', summary: 'first' }, { trigger: 'manual' }])
  })

  it('marks a running compaction failed when the turn ends abnormally', () => {
    const next = counter()
    let s = withCompaction(empty(), { sessionId: 's', type: 'compaction', phase: 'started' }, next)
    s = withTurnEnd(s, 'cancelled', next)
    expect(compactions(s)).toMatchObject([{ phase: 'failed' }])
  })
})
