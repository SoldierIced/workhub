import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { HOST_MAX_LINE_BYTES, HOST_PROTOCOL_VERSION, utf8ByteLength, type HistoryMessage, type SessionHistorySource, type SessionMonitorSnapshot, type TranscriptReader } from '@workhub/core'
import {
  HISTORY_NEXT_METHOD,
  HostChannel,
  HostClient,
  HostServer,
  RESULT_CHUNK_BYTES,
  ResultChunks,
  TRANSCRIPTS_NEXT_METHOD,
  connectRemoteHistorySources,
  connectRemoteTranscriptReaders,
  historySourceHandlers,
  transcriptReaderHandlers,
  type HostHandler,
  type HostHandlers
} from '../src/host'

const hello = { protocol: HOST_PROTOCOL_VERSION, hostVersion: '2.0.0-test', features: [], platform: 'linux' as const, home: '/home/ana', pathFlavor: 'posix' as const }

/** A host and a client over in-memory pipes, recording every line the host writes and every method asked. */
function connect(handlers: HostHandlers) {
  const toHost = new PassThrough()
  const toApp = new PassThrough()
  const lines: number[] = []
  let partial = ''
  toApp.on('data', (b: Buffer) => {
    const parts = (partial + b.toString('utf8')).split('\n')
    partial = parts.pop()!
    for (const line of parts) lines.push(utf8ByteLength(line))
  })
  const asked: string[] = []
  const counted: HostHandlers = Object.fromEntries(
    Object.entries(handlers).map(([m, h]) => [
      m,
      ((p, ctx) => {
        asked.push(m)
        return h(p, ctx)
      }) satisfies HostHandler
    ])
  )
  const client = new HostClient(new HostChannel(toApp, toHost), { expected: { protocol: HOST_PROTOCOL_VERSION, hostVersion: '2.0.0-test' } })
  new HostServer(new HostChannel(toHost, toApp), { hello, handlers: counted })
  return { client, lines, asked }
}

/** `count` agent messages of about `size` characters each, mixing scripts so bytes and characters differ. */
const long = (count: number, size: number): HistoryMessage[] =>
  Array.from({ length: count }, (_, i) => ({ kind: 'agent', at: i, text: `${i} "quoted" ñandú 😀 `.repeat(Math.ceil(size / 24)).slice(0, size) }))

const history = (all: HistoryMessage[]): SessionHistorySource => ({ list: async () => [], messages: async (_id, _cwd, _dir, o) => (o?.last ? all.slice(-o.last) : all) })

describe('history messages over the host, in pieces', () => {
  it('sends a short session whole, in one answer', async () => {
    const { client, asked } = connect(historySourceHandlers({ claude: history(long(3, 100)) }))
    const source = (await connectRemoteHistorySources(client))['claude']!
    await expect(source.messages('abc', '/w/acme')).resolves.toEqual(long(3, 100))
    expect(asked.filter((m) => m === HISTORY_NEXT_METHOD)).toHaveLength(0)
  })

  it('joins a session several lines long, every line under the cap', async () => {
    const all = long(400, 8_000) // about 3.5 MB of JSON
    const { client, lines, asked } = connect(historySourceHandlers({ claude: history(all) }))
    const source = (await connectRemoteHistorySources(client))['claude']!
    await expect(source.messages('abc', '/w/acme')).resolves.toEqual(all)
    expect(asked.filter((m) => m === HISTORY_NEXT_METHOD).length).toBeGreaterThanOrEqual(5)
    expect(Math.max(...lines)).toBeLessThanOrEqual(RESULT_CHUNK_BYTES + 1024)
    expect(Math.max(...lines)).toBeLessThan(HOST_MAX_LINE_BYTES)
    // `last` still narrows on the host.
    await expect(source.messages('abc', '/w/acme', undefined, { last: 2 })).resolves.toEqual(all.slice(-2))
  })

  it('carries one message larger than the line cap intact', async () => {
    const huge: HistoryMessage[] = [{ kind: 'user', text: 'start' }, { kind: 'tool', id: 't1', title: 'Read', detail: 'x\n"y"\\'.repeat(400_000) }]
    const { client, lines } = connect(historySourceHandlers({ claude: history(huge) }))
    const source = (await connectRemoteHistorySources(client))['claude']!
    await expect(source.messages('abc', '/w/acme')).resolves.toEqual(huge)
    expect(Math.max(...lines)).toBeLessThan(HOST_MAX_LINE_BYTES)
  })

  it('refuses an unknown cursor', async () => {
    const { client } = connect(historySourceHandlers({ claude: history([]) }))
    await expect(client.request(HISTORY_NEXT_METHOD, { cursor: 'nope' })).rejects.toMatchObject({ code: 'bad_params' })
    await expect(client.request(HISTORY_NEXT_METHOD, {})).rejects.toMatchObject({ code: 'bad_params' })
  })
})

describe('transcript snapshots over the host, in pieces', () => {
  it('joins a snapshot and a sub-agent conversation larger than a line', async () => {
    const snapshot: SessionMonitorSnapshot = {
      title: 'Big session',
      toolCalls: Array.from({ length: 30_000 }, (_, i) => ({ name: `Tool ${i}`, count: i }) as unknown as NonNullable<SessionMonitorSnapshot['toolCalls']>[number])
    }
    const conversation = { messages: long(200, 8_000) }
    const reader: TranscriptReader = { id: 'claude', read: async () => snapshot, exists: async () => true, forget: () => {}, subagent: async () => conversation as never }
    const { client, lines, asked } = connect(transcriptReaderHandlers([reader]))
    const [remote] = await connectRemoteTranscriptReaders(client)
    await expect(remote!.read({ agentSessionId: 'abc', cwd: '/w/acme' })).resolves.toEqual(snapshot)
    await expect(remote!.subagent!({ agentSessionId: 'abc', cwd: '/w/acme' }, 'sub-1')).resolves.toEqual(conversation)
    expect(asked.filter((m) => m === TRANSCRIPTS_NEXT_METHOD).length).toBeGreaterThan(2)
    expect(Math.max(...lines)).toBeLessThan(HOST_MAX_LINE_BYTES)
  })

  it('still answers null for a session it cannot read', async () => {
    const reader: TranscriptReader = { id: 'claude', read: async () => null, exists: async () => false, forget: () => {} }
    const { client } = connect(transcriptReaderHandlers([reader]))
    const [remote] = await connectRemoteTranscriptReaders(client)
    await expect(remote!.read({ agentSessionId: 'abc', cwd: '/w/acme' })).resolves.toBeNull()
  })
})

/** The next piece, asked outside a server. */
const next = (chunks: ResultChunks, cursor: string) => chunks.handlers['t.next']!({ cursor }, { signal: new AbortController().signal } as never) as { chunk: string; cursor?: string }

describe('ResultChunks', () => {
  const big = 'é'.repeat(5_000)

  it('cuts pieces to the byte budget, never inside a surrogate pair', () => {
    const chunks = new ResultChunks('t.next', { chunkBytes: 101 })
    const value = { text: '😀'.repeat(300) }
    const first = chunks.wrap(value)
    if (!('cursor' in first)) throw new Error('expected pieces')
    const pieces = [first.chunk]
    let cursor: string | undefined = first.cursor
    while (cursor) {
      const piece = next(chunks, cursor)
      pieces.push(piece.chunk)
      cursor = piece.cursor
    }
    for (const p of pieces) {
      expect(utf8ByteLength(JSON.stringify(p))).toBeLessThanOrEqual(101)
      expect(p.charCodeAt(p.length - 1) >= 0xd800 && p.charCodeAt(p.length - 1) <= 0xdbff).toBe(false)
    }
    expect(JSON.parse(pieces.join(''))).toEqual(value)
    expect(chunks.size).toBe(0)
  })

  it('drops a rest nobody asked for in time, and the oldest past the limit', () => {
    let now = 0
    const chunks = new ResultChunks('t.next', { chunkBytes: 1_000, ttlMs: 1_000, maxPending: 2, now: () => now })
    const a = chunks.wrap(big) as { cursor: string }
    chunks.wrap(big)
    chunks.wrap(big)
    expect(chunks.size).toBe(2)
    expect(() => next(chunks, a.cursor)).toThrow('unknown or expired')
    now = 5_000
    expect(chunks.wrap(1)).toEqual({ value: 1 })
    const b = chunks.wrap(big) as { cursor: string }
    expect(chunks.size).toBe(1)
    now = 5_999
    next(chunks, b.cursor)
    now = 6_998
    // Asking for a piece keeps the rest alive.
    expect(() => next(chunks, b.cursor)).not.toThrow()
  })
})
