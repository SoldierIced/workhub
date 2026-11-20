import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import {
  HOST_PROTOCOL_VERSION,
  type HistoryEntry,
  type HistoryMessage,
  type SessionHistorySource,
  type SessionMonitorSnapshot,
  type SubagentConversation,
  type TranscriptQuery,
  type TranscriptReader
} from '@workhub/core'
import type { GitRunner } from '../src/git-review'
import {
  HostChannel,
  HostClient,
  HostServer,
  connectRemoteHistorySources,
  connectRemoteTranscriptReaders,
  gitRunnerHandlers,
  historySourceHandlers,
  remoteGitRunner,
  transcriptReaderHandlers,
  type HostHandlers
} from '../src/host'

const hello = { protocol: HOST_PROTOCOL_VERSION, hostVersion: '2.0.0-test', features: [], platform: 'linux' as const, home: '/home/ana', pathFlavor: 'posix' as const }

function connect(handlers: HostHandlers) {
  const toHost = new PassThrough()
  const toApp = new PassThrough()
  const hostChannel = new HostChannel(toHost, toApp)
  const client = new HostClient(new HostChannel(toApp, toHost), { expected: { protocol: HOST_PROTOCOL_VERSION, hostVersion: '2.0.0-test' } })
  const server = new HostServer(hostChannel, { hello, handlers })
  return { client, server, hostChannel }
}

describe('git runner over the host', () => {
  it('round-trips cwd, args, options and the result', async () => {
    const calls: unknown[] = []
    const run: GitRunner = async (cwd, args, opts) => {
      calls.push({ cwd, args, opts })
      return { ok: true, stdout: 'main\n', stderr: '' }
    }
    const { client } = connect(gitRunnerHandlers(run))
    const git = remoteGitRunner(client)
    await expect(git('/w/acme/api', ['rev-parse', '--abbrev-ref', 'HEAD'], { maxBuffer: 1024, timeoutMs: 5000 })).resolves.toEqual({ ok: true, stdout: 'main\n', stderr: '' })
    expect(calls).toEqual([{ cwd: '/w/acme/api', args: ['rev-parse', '--abbrev-ref', 'HEAD'], opts: { maxBuffer: 1024, timeoutMs: 5000 } }])
  })

  it('keeps a failed command as ok: false with its stderr and timeout flag', async () => {
    const { client } = connect(gitRunnerHandlers(async () => ({ ok: false, stdout: '', stderr: 'fatal: not a git repository', timedOut: true })))
    await expect(remoteGitRunner(client)('/w/acme', ['status'])).resolves.toEqual({ ok: false, stdout: '', stderr: 'fatal: not a git repository', timedOut: true })
  })

  it('answers ok: false instead of rejecting when the host fails or is gone', async () => {
    const broken = connect(gitRunnerHandlers(async () => Promise.reject(new Error('spawn git ENOENT'))))
    await expect(remoteGitRunner(broken.client)('/w/acme', ['status'])).resolves.toEqual({ ok: false, stdout: '', stderr: 'spawn git ENOENT' })
    const gone = connect(gitRunnerHandlers(async () => ({ ok: true, stdout: '', stderr: '' })))
    await gone.client.ready
    gone.hostChannel.close()
    const result = await remoteGitRunner(gone.client)('/w/acme', ['status'])
    expect(result.ok).toBe(false)
    expect(result.stderr).toMatch(/closed/)
  })

  it('refuses bad params on the host side', async () => {
    const { client } = connect(gitRunnerHandlers(async () => ({ ok: true, stdout: '', stderr: '' })))
    await expect(client.request('git.run', { cwd: '/w/acme', args: 'status' })).rejects.toMatchObject({ code: 'bad_params' })
    await expect(client.request('git.run', { cwd: '/w/acme', args: [], opts: { timeoutMs: -1 } })).rejects.toMatchObject({ code: 'bad_params' })
  })
})

const snapshot: SessionMonitorSnapshot = { model: 'model-a' } as SessionMonitorSnapshot
const conversation: SubagentConversation = { id: 'sub-1', description: 'look around' } as SubagentConversation

class FakeReader implements TranscriptReader {
  readonly forgotten: string[] = []
  readonly queries: TranscriptQuery[] = []
  constructor(readonly id: string) {}
  async read(query: TranscriptQuery): Promise<SessionMonitorSnapshot | null> {
    this.queries.push(query)
    if (query.agentSessionId === 'broken') throw new Error('transcript is locked')
    return query.agentSessionId === 'missing' ? null : snapshot
  }
  async exists(query: TranscriptQuery): Promise<boolean> {
    return query.agentSessionId !== 'missing'
  }
  forget(agentSessionId: string): void {
    this.forgotten.push(agentSessionId)
  }
}

class FakeReaderWithSubagents extends FakeReader {
  async subagent(_query: TranscriptQuery, subagentId: string): Promise<SubagentConversation | null> {
    return subagentId === 'sub-1' ? conversation : null
  }
}

describe('transcript readers over the host', () => {
  it('lists the host readers, with subagent only where the host reader has it', async () => {
    const { client } = connect(transcriptReaderHandlers([new FakeReaderWithSubagents('claude'), new FakeReader('kiro')]))
    const readers = await connectRemoteTranscriptReaders(client)
    expect(readers.map((r) => r.id)).toEqual(['claude', 'kiro'])
    expect(typeof readers[0]!.subagent).toBe('function')
    expect(readers[1]!.subagent).toBeUndefined()
  })

  it('round-trips read, exists, subagent and forget', async () => {
    const claude = new FakeReaderWithSubagents('claude')
    const { client } = connect(transcriptReaderHandlers([claude]))
    const [reader] = await connectRemoteTranscriptReaders(client)
    const query: TranscriptQuery = { agentSessionId: 'abc', cwd: '/w/acme/api', configDir: '/home/ana/.claude-work', ticketPrefixes: ['PAY'] }
    await expect(reader!.read(query)).resolves.toEqual(snapshot)
    expect(claude.queries).toEqual([query])
    await expect(reader!.read({ agentSessionId: 'missing', cwd: '/w/acme' })).resolves.toBeNull()
    await expect(reader!.exists({ agentSessionId: 'missing', cwd: '/w/acme' })).resolves.toBe(false)
    await expect(reader!.exists(query)).resolves.toBe(true)
    await expect(reader!.subagent!(query, 'sub-1')).resolves.toEqual(conversation)
    await expect(reader!.subagent!(query, 'sub-2')).resolves.toBeNull()
    reader!.forget('abc')
    await expect(reader!.exists(query)).resolves.toBe(true)
    expect(claude.forgotten).toEqual(['abc'])
  })

  it('passes a reader error through with its message, and refuses unknown readers', async () => {
    const { client } = connect(transcriptReaderHandlers([new FakeReader('claude')]))
    const [reader] = await connectRemoteTranscriptReaders(client)
    await expect(reader!.read({ agentSessionId: 'broken', cwd: '/w/acme' })).rejects.toThrow('transcript is locked')
    await expect(client.request('transcripts.read', { reader: 'nope', query: { agentSessionId: 'a', cwd: '/w' } })).rejects.toMatchObject({ code: 'bad_params' })
    await expect(client.request('transcripts.read', { reader: 'claude', query: { cwd: '/w' } })).rejects.toMatchObject({ code: 'bad_params' })
  })
})

const entry: HistoryEntry = { agentId: 'claude', accountId: 'work', agentSessionId: 'abc', title: 'Fix the login form', cwd: '/w/acme/web', lastModified: 1_700_000_000_000 }
const messages: HistoryMessage[] = [
  { kind: 'user', text: 'fix PAY-123', images: 1, imageData: [{ mediaType: 'image/png', data: 'aGVsbG8=' }] },
  { kind: 'agent', text: 'Done.' },
  { kind: 'tool', id: 't1', title: 'Edit form.tsx', failed: false }
]

function fakeHistory(withExtras: boolean): SessionHistorySource & { renamed: unknown[]; listed: unknown[] } {
  const renamed: unknown[] = []
  const listed: unknown[] = []
  const base: SessionHistorySource & { renamed: unknown[]; listed: unknown[] } = {
    renamed,
    listed,
    async list(account, options) {
      listed.push({ account, options })
      if (account.accountId === 'broken') throw new Error('session store unreadable')
      return [entry]
    },
    async messages(agentSessionId, cwd, configDir, options) {
      return agentSessionId === 'abc' && cwd === '/w/acme/web' && configDir === '/home/ana/.claude-work' && options?.last === 2 ? messages.slice(-2) : messages
    }
  }
  if (!withExtras) return base
  return {
    ...base,
    async sessionIds() {
      return new Set(['abc', 'def'])
    },
    async rename(agentSessionId, cwd, title, configDir) {
      renamed.push({ agentSessionId, cwd, title, configDir })
    }
  }
}

describe('session history over the host', () => {
  it('exposes the optional methods only where the host source has them', async () => {
    const { client } = connect(historySourceHandlers({ claude: fakeHistory(true), kiro: fakeHistory(false) }))
    const sources = await connectRemoteHistorySources(client)
    expect(Object.keys(sources).sort()).toEqual(['claude', 'kiro'])
    expect(typeof sources['claude']!.sessionIds).toBe('function')
    expect(typeof sources['claude']!.rename).toBe('function')
    expect(sources['kiro']!.sessionIds).toBeUndefined()
    expect(sources['kiro']!.rename).toBeUndefined()
  })

  it('round-trips list, sessionIds, messages and rename', async () => {
    const claude = fakeHistory(true)
    const { client } = connect(historySourceHandlers({ claude }))
    const source = (await connectRemoteHistorySources(client))['claude']!
    const account = { agentId: 'claude', accountId: 'work', configDir: '/home/ana/.claude-work' }
    await expect(source.list(account, { limit: 5 })).resolves.toEqual([entry])
    expect(claude.listed).toEqual([{ account, options: { limit: 5 } }])
    await expect(source.sessionIds!(account)).resolves.toEqual(new Set(['abc', 'def']))
    await expect(source.messages('abc', '/w/acme/web')).resolves.toEqual(messages)
    await expect(source.messages('abc', '/w/acme/web', '/home/ana/.claude-work', { last: 2 })).resolves.toEqual(messages.slice(-2))
    await source.rename!('abc', '/w/acme/web', 'Login form', '/home/ana/.claude-work')
    expect(claude.renamed).toEqual([{ agentSessionId: 'abc', cwd: '/w/acme/web', title: 'Login form', configDir: '/home/ana/.claude-work' }])
  })

  it('passes a source error through and refuses bad params', async () => {
    const { client } = connect(historySourceHandlers({ claude: fakeHistory(false) }))
    const source = (await connectRemoteHistorySources(client))['claude']!
    await expect(source.list({ agentId: 'claude', accountId: 'broken' })).rejects.toThrow('session store unreadable')
    await expect(client.request('history.rename', { source: 'claude', agentSessionId: 'abc', cwd: '/w', title: 'x' })).rejects.toMatchObject({ code: 'bad_params' })
    await expect(client.request('history.list', { source: 'claude', account: { agentId: 'claude' } })).rejects.toMatchObject({ code: 'bad_params' })
  })
})
