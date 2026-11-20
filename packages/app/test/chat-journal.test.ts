import { describe, expect, it } from 'vitest'
import type { AgentEvent, HistoryMessage } from '@workhub/core'
import { ChatJournals } from '../src/main/chat-journal'
import type { ChatJournal } from '../src/shared/chat-journal'
import type { SessionView } from '../src/shared/api'
import {
  applyEvent,
  fromJournal,
  getSessions,
  hydrateSession,
  onChanged,
  onEvent,
  onRemoved,
  pushTurnEnd,
  pushUser,
  withReplay,
  withTurnEnd,
  type ChatItem,
  type SessionData
} from '../src/renderer/store'

const ev = (sessionId: string, e: Record<string, unknown>) => ({ sessionId, ...e }) as AgentEvent
/** The chat without what differs between two windows: item ids and the times they were stamped. */
const shape = (items: readonly ChatItem[]) => items.map(({ id: _id, at: _at, ...rest }: ChatItem & { at?: number }) => rest)
const lastSeq = (args: unknown[]) => args[args.length - 1] as number

describe('what the user first asked', () => {
  it('is the first prompt that says something, from a prompt or a resumed conversation', () => {
    const j = new ChatJournals()
    expect(j.firstPrompt('s')).toBeUndefined()
    j.tap('automations:prompted', ['s', '/clear'])
    expect(j.firstPrompt('s')).toBeUndefined()
    j.tap('automations:prompted', ['s', 'Refactor the billing module'])
    j.tap('automations:prompted', ['s', 'And then add tests'])
    expect(j.firstPrompt('s')).toBe('Refactor the billing module')
    j.tap('session:replay', ['r', [{ kind: 'agent', text: 'hi' }, { kind: 'user', text: 'Earlier ask' }] as HistoryMessage[]])
    expect(j.firstPrompt('r')).toBe('Earlier ask')
    j.tap('session:removed', ['s'])
    expect(j.firstPrompt('s')).toBeUndefined()
  })
})

describe('the first prompt of a long session', () => {
  it('is shortened once and survives the trimming of the entries that held it', () => {
    const j = new ChatJournals({ entries: 3, bytes: 1_000_000 })
    j.tap('automations:prompted', ['s', '  Refactor the billing module\nand add tests '])
    expect(j.firstPrompt('s')).toBe('Refactor the billing module')
    for (let i = 0; i < 6; i++) j.tap('automations:prompted', ['s', `Later ask ${i}`])
    expect(j.get('s').truncated).toBe(true)
    expect(j.get('s').entries.some((e) => e.kind === 'prompt' && e.text.startsWith('  Refactor'))).toBe(false)
    expect(j.firstPrompt('s')).toBe('Refactor the billing module')
  })

  it('can be handed back after a restart, and wins over a later replay', () => {
    const j = new ChatJournals()
    j.restoreFirstPrompt('s', 'Refactor the billing module')
    j.tap('session:replay', ['s', [{ kind: 'user', text: 'Something later' }] as HistoryMessage[]])
    expect(j.firstPrompt('s')).toBe('Refactor the billing module')
  })
})

describe('chat journal bounds', () => {
  it('numbers chat messages, merges streamed deltas and leaves other messages alone', () => {
    const j = new ChatJournals(undefined, () => 7)
    expect(j.tap('session:event', [ev('s', { type: 'message', role: 'agent', text: 'Hel' })])).toEqual([expect.anything(), 1])
    expect(lastSeq(j.tap('session:event', [ev('s', { type: 'message', role: 'agent', text: 'lo' })]))).toBe(2)
    // Terminal output and events the chat does not show are not recorded.
    expect(j.tap('session:event', [ev('s:console', { type: 'output', data: 'x' })])).toHaveLength(1)
    expect(j.tap('session:event', [ev('s', { type: 'state', state: 'busy' })])).toHaveLength(1)
    expect(j.tap('session:changed', [{ id: 's' }])).toEqual([{ id: 's' }])
    expect(j.nextSeq('s')).toBe(3)
    expect(j.get('s')).toEqual({
      seq: 2,
      truncated: false,
      monitor: {},
      entries: [{ kind: 'event', seq: 2, at: 7, event: ev('s', { type: 'message', role: 'agent', text: 'Hello' }) }]
    })
    // The monitor is merged, not kept as entries.
    j.tap('session:event', [ev('s', { type: 'monitor', snapshot: { model: 'm1' } })])
    j.tap('session:event', [ev('s', { type: 'monitor', snapshot: { contextUsed: 5 } })])
    expect(j.get('s')).toMatchObject({ seq: 4, monitor: { model: 'm1', contextUsed: 5 } })
    expect(j.get('s').entries).toHaveLength(1)
  })

  it('drops the oldest entries past its count and its size, and says so', () => {
    const j = new ChatJournals({ entries: 3, bytes: 10_000 })
    for (let i = 0; i < 5; i++) j.tap('automations:prompted', ['s', `prompt ${i}`])
    expect(j.get('s').entries.map((e) => (e.kind === 'prompt' ? e.text : ''))).toEqual(['prompt 2', 'prompt 3', 'prompt 4'])
    expect(j.get('s').truncated).toBe(true)

    // Each of these prompts is some 150 characters of JSON.
    const small = new ChatJournals({ entries: 100, bytes: 400 })
    small.tap('automations:prompted', ['s', 'a'.repeat(100)])
    small.tap('automations:prompted', ['s', 'b'.repeat(100)])
    expect(small.get('s').truncated).toBe(false)
    small.tap('automations:prompted', ['s', 'c'.repeat(100)])
    expect(small.get('s')).toMatchObject({ truncated: true, entries: [{ text: 'b'.repeat(100) }, { text: 'c'.repeat(100) }] })
    // A streamed reply counts its growth too.
    small.tap('session:event', [ev('s', { type: 'message', role: 'agent', text: 'd' })])
    expect(small.get('s').entries.map((e) => e.kind)).toEqual(['prompt', 'event'])
    small.tap('session:event', [ev('s', { type: 'message', role: 'agent', text: 'd'.repeat(150) })])
    expect(small.get('s').entries.map((e) => e.kind)).toEqual(['event'])
    // The newest entry stays even when it alone is past the size.
    small.tap('automations:prompted', ['s', 'e'.repeat(500)])
    expect(small.get('s').entries).toMatchObject([{ kind: 'prompt', text: 'e'.repeat(500) }])
  })

  it('starts over from a replayed conversation, keeping its newest messages within the bounds', () => {
    const j = new ChatJournals({ entries: 3, bytes: 10_000 })
    j.tap('automations:prompted', ['s', 'before the resume'])
    const messages: HistoryMessage[] = [1, 2, 3, 4].map((n) => ({ kind: 'agent', text: `m${n}` }))
    expect(lastSeq(j.tap('session:replay', ['s', messages]))).toBe(2)
    expect(j.get('s')).toMatchObject({ truncated: true, entries: [{ kind: 'replay', messages: messages.slice(1) }] })
    j.tap('session:replay', ['s', messages.slice(0, 2)])
    expect(j.get('s')).toMatchObject({ truncated: false, entries: [{ kind: 'replay', messages: messages.slice(0, 2) }] })
  })

  it('forgets a session when it is removed', () => {
    const j = new ChatJournals()
    j.tap('automations:prompted', ['s', 'hi'])
    j.tap('automations:prompted', ['t', 'hi'])
    expect(j.tap('session:removed', ['s'])).toEqual(['s'])
    expect(j.get('s')).toEqual({ seq: 0, truncated: false, entries: [], monitor: {} })
    expect(j.get('t').entries).toHaveLength(1)
  })
})

/** A session that runs a turn with a tool call, a permission request and a streamed reply. */
const stream = (id: string): [string, unknown[]][] => [
  ['automations:prompted', [id, 'fix the build']],
  ['session:event', [ev(id, { type: 'message', role: 'thought', text: 'Look' })]],
  ['session:event', [ev(id, { type: 'message', role: 'thought', text: 'ing' })]],
  ['session:event', [ev(id, { type: 'tool', toolCallId: 't1', title: 'Run npm test', status: 'pending', view: { kind: 'command', command: 'npm test' } })]],
  ['session:event', [ev(id, { type: 'permission', requestId: 'r1', title: 'Run npm test', options: [{ optionId: 'ok', name: 'Allow', kind: 'allow_once' }] })]],
  ['session:event', [ev(id, { type: 'permissionCancelled', requestId: 'r1' })]],
  ['session:event', [ev(id, { type: 'tool', toolCallId: 't1', status: 'completed', result: { text: '3 passed', exitCode: 0 } })]],
  ['session:event', [ev(id, { type: 'monitor', snapshot: { model: 'model-a' } })]],
  ['session:event', [ev(id, { type: 'notice', noticeId: 'n1', kind: 'hook', title: 'Stop hook', text: 'ok' })]],
  ['session:event', [ev(id, { type: 'message', role: 'agent', text: 'All ' })]],
  ['session:event', [ev(id, { type: 'message', role: 'agent', text: 'green.' })]],
  ['automations:turnEnded', [id, 'end_turn']],
  ['session:event', [ev(id, { type: 'compaction', phase: 'started' })]],
  ['session:event', [ev(id, { type: 'compaction', phase: 'done', summary: 'short' })]],
  ['automations:prompted', [id, 'and the docs']],
  ['session:event', [ev(id, { type: 'message', role: 'agent', text: 'Done.' })]],
  ['automations:turnEnded', [id, 'cancelled']],
  ['session:event', [ev(id, { type: 'exit', code: 0 })]]
]

const view = (id: string): SessionView => ({ id, state: 'ready', cwd: '/tmp/x', startedAt: 1 }) as SessionView

/** Sends one recorded message to the store the way the window's listeners do. */
function deliver(channel: string, args: unknown[]): void {
  if (channel === 'session:event') onEvent(args[0] as AgentEvent, args[1] as number)
  if (channel === 'automations:prompted') pushUser(args[0] as string, args[1] as string, undefined, args[2] as number)
  if (channel === 'automations:turnEnded') pushTurnEnd(args[0] as string, args[1] as string, args[2] as number)
}

describe('a chat rebuilt from the journal', () => {
  let n = 0
  const next = () => ++n
  const empty = (): SessionData => ({ view: { id: 's' } as SessionData['view'], items: [], monitor: {} })

  it('equals the live chat of the same messages', () => {
    const journal = new ChatJournals()
    let live = empty()
    for (const [channel, args] of [...stream('s'), ['session:replay', ['s', [{ kind: 'user', text: 'earlier' }]]] as [string, unknown[]], ...stream('s')]) {
      const sent = journal.tap(channel, args)
      if (channel === 'session:event') live = applyEvent(live, sent[0] as AgentEvent, next)
      if (channel === 'automations:prompted') live = { ...live, items: [...live.items, { id: next(), kind: 'user', text: sent[1] as string }] }
      if (channel === 'automations:turnEnded') live = withTurnEnd(live, sent[1] as string, next)
      if (channel === 'session:replay') live = withReplay(live, sent[1] as HistoryMessage[], next)
    }
    const rebuilt = fromJournal(empty(), journal.get('s'), next)
    expect(shape(rebuilt.items)).toEqual(shape(live.items))
    expect(rebuilt.monitor).toEqual(live.monitor)
    // Rebuilt items keep the times main recorded.
    expect(rebuilt.items.filter((i) => i.kind === 'turnEnd').every((i) => i.kind === 'turnEnd' && i.at !== undefined && i.at <= Date.now())).toBe(true)
  })

  it('shows that earlier messages are left out', () => {
    const journal = new ChatJournals({ entries: 4, bytes: 100_000 })
    for (const [channel, args] of stream('s')) journal.tap(channel, args)
    const rebuilt = fromJournal(empty(), journal.get('s'), next)
    expect(rebuilt.items[0]!.kind).toBe('truncated')
    expect(rebuilt.items).toHaveLength(5)
  })

  it('rebuilds a reloaded window like the one that followed the session live', async () => {
    const journal = new ChatJournals()
    onChanged(view('live-1'))
    for (const [channel, args] of stream('live-1')) deliver(channel, journal.tap(channel, args))
    const before = shape(getSessions()['live-1']!.items)
    expect(before.length).toBeGreaterThan(5)
    // The reloaded window starts with only the session's view, then asks main for the chat.
    onRemoved('live-1')
    onChanged(view('live-1'))
    expect(getSessions()['live-1']!.items).toEqual([])
    await hydrateSession('live-1', async (id) => journal.get(id))
    expect(shape(getSessions()['live-1']!.items)).toEqual(before)
    onRemoved('live-1')
  })

  it('applies the live messages that arrive while it rebuilds once, with no gap', async () => {
    const id = 'hydrate-1'
    const journal = new ChatJournals()
    const messages = stream(id)
    onChanged(view(id))
    // A window that saw nothing of the first half (it loaded later).
    for (const [channel, args] of messages.slice(0, 6)) journal.tap(channel, args)
    let reply: (j: ChatJournal) => void = () => undefined
    const hydrated = hydrateSession(id, () => new Promise((resolve) => (reply = resolve)))
    // Live messages go on while main answers: some before main took its copy, some after.
    const early = messages.slice(6, 10).map(([c, a]) => [c, journal.tap(c, a)] as const)
    const copy = journal.get(id)
    const late = messages.slice(10).map(([c, a]) => [c, journal.tap(c, a)] as const)
    deliver(...early[0]!)
    deliver(...early[1]!)
    deliver(...late[0]!)
    reply(copy)
    await hydrated
    // The rest arrive after the answer, the earlier ones overtaken by it.
    for (const m of [...early.slice(2), ...late.slice(1)]) deliver(...m)
    const expected = fromJournal(getSessions()[id]!, journal.get(id), next)
    expect(shape(getSessions()[id]!.items)).toEqual(shape(expected.items))
    expect(getSessions()[id]!.items.filter((i) => i.kind === 'user')).toHaveLength(2)
    onRemoved(id)
  })

  it('shows a prompt once in the window that sent it, which learned its number first', () => {
    const id = 'sender-1'
    const journal = new ChatJournals()
    onChanged(view(id))
    const seq = journal.nextSeq(id)
    pushUser(id, 'with a picture', ['data:image/png;base64,AAA'], seq)
    const [, broadcast] = ['automations:prompted', journal.tap('automations:prompted', [id, 'with a picture'])] as const
    expect(lastSeq(broadcast)).toBe(seq)
    deliver('automations:prompted', broadcast)
    expect(getSessions()[id]!.items).toEqual([expect.objectContaining({ kind: 'user', text: 'with a picture', images: ['data:image/png;base64,AAA'] })])
    // The turn's end from main and the sender's own one make one divider.
    deliver('automations:turnEnded', journal.tap('automations:turnEnded', [id, 'end_turn']))
    pushTurnEnd(id, 'end_turn')
    expect(getSessions()[id]!.items.map((i) => i.kind)).toEqual(['user', 'turnEnd'])
    onRemoved(id)
  })
})
