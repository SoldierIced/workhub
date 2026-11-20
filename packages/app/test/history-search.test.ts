import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cutSnippet, emptyConfig, HISTORY_MARK, snippetHtmlMarks, snippetParts, type HistoryEntry, type HistoryMessage, type SessionHistorySource } from '@workhub/core'
import { SqliteHistoryIndex, type WorkhubDb } from '@workhub/adapters/sqlite-store'
import { HistoryIndexer, listedKey } from '../src/main/history-indexer'
import { historySearchOptions, listAllHistory, searchAllHistory } from '../src/main/history'
import { HISTORY_SEARCH_BYTES, recordIpc, RemoteHub, remoteHistorySearch } from '../src/main/remote'
import { REMOTE_INVOKES } from '../src/main/remote/allowlist'
import type { IpcRegistrar } from '../src/main/ipc-guard'
import type { HistoryIndexProgress, HistoryItem, HistoryMatch, HistoryResult, HistorySearchResult } from '../src/shared/api'
import { HistoryIndexingNote, HistorySnippet } from '../src/renderer/components/molecules/HistorySnippet'
import { searchScope, shouldSearchAgain } from '../src/renderer/screens/HistoryScreen'
import { HistorySearchBody, searchErrorKey } from '../src/web/screens/HistoryScreen'
import { NO_ANSWER_ERROR } from '../src/web/remote-client'
import { openTestDb } from './test-db'

const T = Date.UTC(2026, 10, 1, 12)
const { open: O, close: C } = HISTORY_MARK
const dbs: WorkhubDb[] = []
afterEach(() => {
  for (const db of dbs.splice(0)) db.close()
})

function item(id: string, fields: Partial<HistoryItem> = {}): HistoryItem {
  return { agentId: 'claude', accountId: null, agentSessionId: id, title: `Session ${id}`, lastModified: T, sizeBytes: 10, cwd: '/w/acme/api', agentName: 'Claude', resumable: true, ...fields }
}

function harness(initial: HistoryItem[], conversations: Record<string, string>) {
  const db = openTestDb()
  dbs.push(db)
  const index = new SqliteHistoryIndex(db)
  let entries = initial
  let listed: string[] | undefined = [listedKey('claude', null)]
  let accounts: string[] | undefined
  const reads: string[] = []
  const lists: boolean[] = []
  const progress: HistoryIndexProgress[] = []
  const indexer = new HistoryIndexer({
    index,
    list: async (fresh) => {
      lists.push(fresh)
      return { entries, listed, accounts }
    },
    messages: async (e: HistoryEntry): Promise<HistoryMessage[]> => {
      reads.push(e.agentSessionId)
      const text = conversations[e.agentSessionId]
      if (text === undefined) throw new Error('gone')
      return [
        { kind: 'user', text },
        { kind: 'tool', id: 't', title: 'Bash', detail: 'toolonlyword' }
      ]
    },
    onProgress: (p) => progress.push(p),
    batchSize: 2,
    pause: async () => undefined
  })
  return {
    db,
    index,
    indexer,
    reads,
    lists,
    progress,
    setEntries: (next: HistoryItem[]) => (entries = next),
    setListed: (next: string[]) => (listed = next),
    setAccounts: (next: string[]) => (accounts = next),
    listing: (): HistoryResult => ({ entries, errors: [] })
  }
}

const idle: HistoryIndexProgress = { indexing: false, indexed: 0, total: 0 }
const ids = (r: HistorySearchResult) => r.entries.map((e) => e.agentSessionId)

describe('HistoryIndexer', () => {
  it('indexes every session once, then only those whose time, size or title changed', async () => {
    const h = harness([item('a'), item('b'), item('c'), item('d')], { a: 'alpha deploy', b: 'bravo', c: 'charlie', d: 'delta' })
    await h.indexer.refresh()
    expect(h.reads.sort()).toEqual(['a', 'b', 'c', 'd'])
    expect(h.indexer.progress()).toEqual({ indexing: false, indexed: 4, total: 4 })
    expect(h.progress.some((p) => p.indexing && p.indexed < p.total)).toBe(true)
    expect(h.index.match('toolonlyword')).toEqual([])

    h.reads.length = 0
    await h.indexer.refresh()
    expect(h.reads).toEqual([])

    h.setEntries([item('a', { lastModified: T + 1 }), item('b', { sizeBytes: 11 }), item('c', { title: 'Renamed in Workhub' }), item('d')])
    await h.indexer.refresh()
    expect(h.reads.sort()).toEqual(['a', 'b', 'c'])
  })

  it('reads a session with neither time nor size every round', async () => {
    const h = harness([item('k', { lastModified: 0, sizeBytes: undefined, agentId: 'kiro' })], { k: '' })
    await h.indexer.refresh()
    await h.indexer.refresh()
    expect(h.reads).toEqual(['k', 'k'])
  })

  it('drops gone sessions of fully listed accounts and every session of an account no longer configured', async () => {
    const h = harness([item('a'), item('b'), item('z', { agentId: 'codex' }), item('x', { accountId: 'old' })], { a: 'alpha', b: 'bravo', z: 'zulu', x: 'xray' })
    await h.indexer.refresh()
    expect(h.index.count()).toBe(4)
    // Codex and the old account were not listed this round: their sessions stay; Claude's missing one goes.
    h.setEntries([item('a')])
    await h.indexer.refresh()
    expect([...h.index.stamps().keys()].sort()).toEqual(['claude:a', 'claude:x', 'codex:z'])
    h.setAccounts([listedKey('claude', null), listedKey('codex', null)])
    await h.indexer.refresh()
    expect([...h.index.stamps().keys()].sort()).toEqual(['claude:a', 'codex:z'])
    h.setListed([listedKey('claude', null), listedKey('codex', null)])
    await h.indexer.refresh()
    expect([...h.index.stamps().keys()]).toEqual(['claude:a'])
  })

  it('skips a session it could not read until its stamp changes', async () => {
    const h = harness([item('a'), item('broken')], { a: 'alpha' })
    await h.indexer.refresh()
    expect([...h.index.stamps().keys()]).toEqual(['claude:a'])
    expect(h.indexer.progress()).toMatchObject({ indexed: 1, total: 2 })
    h.reads.length = 0
    await h.indexer.refresh()
    expect(h.reads).toEqual([])
    h.setEntries([item('a'), item('broken', { lastModified: T + 5 })])
    await h.indexer.refresh()
    expect(h.reads).toEqual(['broken'])
  })

  it('writes nothing once stopped or once the database closed', async () => {
    const h = harness([item('a')], { a: 'alpha' })
    h.indexer.stop()
    await h.indexer.refresh()
    expect(h.reads).toEqual([])
    const g = harness([item('a')], { a: 'alpha' })
    g.db.close()
    await expect(g.indexer.refresh()).resolves.toBeUndefined()
    expect(g.reads).toEqual([])
  })

  it('coalesces the refreshes after a session stops into one, with a fresh listing', async () => {
    vi.useFakeTimers()
    try {
      const h = harness([item('a')], { a: 'alpha' })
      h.indexer.refreshSoon(1000)
      h.indexer.refreshSoon(1000)
      await vi.advanceTimersByTimeAsync(1000)
      expect(h.lists).toEqual([true])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('History beyond the listing depth', () => {
  // 450 Claude sessions on disk, newest first; s449 is the oldest. Each conversation names its session.
  function deepHistory(options: { sessionIds?: boolean } = {}) {
    const db = openTestDb()
    dbs.push(db)
    const index = new SqliteHistoryIndex(db)
    const onDisk = new Set(Array.from({ length: 450 }, (_, i) => `s${i}`))
    const all = () => [...onDisk].map((id) => item(id, { lastModified: T - Number(id.slice(1)) * 60_000 }))
    const source: SessionHistorySource = {
      list: async (_a, o) => all().slice(0, o?.limit ?? 400),
      messages: async (id) => [{ kind: 'user', text: `conversation about topic${id}` }],
      ...(options.sessionIds === false ? {} : { sessionIds: async () => new Set(onDisk) })
    }
    let depth = 400
    const list = () => listAllHistory(emptyConfig(), '/home/u', { claude: source }, { depth, indexed: (a, acc) => index.entries(a, acc) })
    const indexer = new HistoryIndexer({ index, list: () => list(), messages: (e) => source.messages(e.agentSessionId, e.cwd ?? ''), batchSize: 50, pause: async () => undefined })
    const search = async (q: string) => ids(searchAllHistory(await list(), index, q, {}, idle))
    return { index, indexer, onDisk, list, search, deeper: () => (depth = 500), shallower: () => (depth = 400) }
  }
  
  it('keeps older sessions indexed, listed and found, and drops one only once its transcript is gone', async () => {
    const h = deepHistory()
    // The user listed further back once: every session is indexed.
    h.deeper()
    await h.indexer.refresh()
    expect(h.index.count()).toBe(450)
    // Back to the start-up depth (the app restarted): the older 50 stay in the index, the listing and search.
    h.shallower()
    const listing = await h.list()
    expect(listing.truncated).toEqual([listedKey('claude', null)])
    expect(listing.entries.some((e) => e.agentSessionId === 's449')).toBe(true)
    await h.indexer.refresh()
    expect(h.index.count()).toBe(450)
    expect(await h.search('topics449')).toEqual(['s449'])
    // An old transcript deleted on disk leaves the index; its neighbours stay.
    h.onDisk.delete('s420')
    await h.indexer.refresh()
    expect(h.index.count()).toBe(449)
    expect(await h.search('topics420')).toEqual([])
    expect(await h.search('topics421')).toEqual(['s421'])
  })

  it('never drops an older indexed session of a source that cannot tell which transcripts exist', async () => {
    const h = deepHistory({ sessionIds: false })
    h.deeper()
    await h.indexer.refresh()
    h.shallower()
    const listing = await h.list()
    expect([listing.entries.length, listing.listed]).toEqual([400, []])
    await h.indexer.refresh()
    expect(h.index.count()).toBe(450)
  })
})

describe('searchAllHistory', () => {
  it('lists index matches first, then plain matches, each once, with a truthful total and cursor', async () => {
    const h = harness([item('a', { title: 'Release' }), item('b', { title: 'Deploy notes' }), item('c', { title: 'Notes' })], { a: 'we talked about the deploy window', b: 'nothing here', c: 'nothing' })
    await h.indexer.refresh()
    h.setEntries([...h.listing().entries, item('new', { title: 'Deploy checklist' }), item('cjk', { title: '部署の手順' })])
    const r = searchAllHistory(h.listing(), h.index, 'deploy', {}, idle)
    expect(ids(r).slice(0, 2).sort()).toEqual(['a', 'b'])
    expect(ids(r)).toEqual([...ids(r).slice(0, 2), 'new'])
    expect(r.entries.find((e) => e.agentSessionId === 'a')).toMatchObject({ agentName: 'Claude', snippet: expect.stringContaining(`${O}deploy${C}`) })
    expect(r.entries.find((e) => e.agentSessionId === 'new')!.snippet).toBeUndefined()
    expect(r.total).toBe(3)
    const first = searchAllHistory(h.listing(), h.index, 'deploy', { limit: 2 }, idle)
    const second = searchAllHistory(h.listing(), h.index, 'deploy', { limit: 2, cursor: first.nextCursor }, idle)
    expect(first.nextCursor).toBe('2')
    expect(second.nextCursor).toBeUndefined()
    expect([...ids(first), ...ids(second)].sort()).toEqual(['a', 'b', 'new'])
    // Substrings and any script, through the plain match.
    expect(ids(searchAllHistory(h.listing(), h.index, '手順', {}, idle))).toEqual(['cjk'])
    // No index at all: the plain match answers alone.
    expect(ids(searchAllHistory(h.listing(), null, 'deploy', {}, idle)).sort()).toEqual(['b', 'new'])
  })

  it('finds an indexed session by branch, by rename and by a word inside another', async () => {
    const h = harness([item('br', { gitBranch: 'feature/ledger-sync' }), item('rn'), item('pg', { title: 'Fix PaymentGateway timeouts' })], { br: 'x', rn: 'y', pg: 'z' })
    await h.indexer.refresh()
    expect(ids(searchAllHistory(h.listing(), h.index, 'ledger', {}, idle))).toEqual(['br'])
    h.setEntries([item('br', { gitBranch: 'feature/ledger-sync' }), item('rn', { title: 'Quarterly invoices' }), item('pg', { title: 'Fix PaymentGateway timeouts' })])
    expect(ids(searchAllHistory(h.listing(), h.index, 'invoices', {}, idle))).toEqual(['rn'])
    await h.indexer.refresh()
    expect(searchAllHistory(h.listing(), h.index, 'invoices', {}, idle).entries[0]!.titleSnippet).toBe(`Quarterly ${O}invoices${C}`)
    expect(ids(searchAllHistory(h.listing(), h.index, 'gateway', {}, idle))).toEqual(['pg'])
  })

  it('applies agent, accounts, folders and keys before paging', async () => {
    const many = Array.from({ length: 30 }, (_, i) => item(`m${i}`, { cwd: '/w/acme/web' }))
    const h = harness([item('a'), item('b', { cwd: '/w/acme/web', agentId: 'codex' }), item('c', { accountId: 'acct-2' }), ...many], { a: 'shared term', b: 'shared term', c: 'shared term', ...Object.fromEntries(many.map((m) => [m.agentSessionId, 'shared term'])) })
    await h.indexer.refresh()
    expect(ids(searchAllHistory(h.listing(), h.index, 'shared', { agent: 'codex' }, idle))).toEqual(['b'])
    expect(ids(searchAllHistory(h.listing(), h.index, 'shared', { cwdPrefix: '/w/acme/api', limit: 5 }, idle)).sort()).toEqual(['a', 'c'])
    expect(ids(searchAllHistory(h.listing(), h.index, 'shared', { accountIds: ['acct-2'] }, idle))).toEqual(['c'])
    expect(ids(searchAllHistory(h.listing(), h.index, 'shared', { keys: ['claude:a'], limit: 1 }, idle))).toEqual(['a'])
    expect(searchAllHistory(h.listing(), h.index, 'shared', { cwdPrefixes: [] }, idle).total).toBe(0)
  })

  it('takes only well-formed options from a caller', () => {
    expect(historySearchOptions({ agent: 'claude', cwdPrefix: '/w', since: 1, until: 2, limit: 999, cursor: '50', keys: ['claude:a'], accountIds: [''], extra: 'x' })).toEqual({
      agent: 'claude',
      cwdPrefix: '/w',
      since: 1,
      until: 2,
      limit: 200,
      cursor: '50',
      keys: ['claude:a'],
      accountIds: ['']
    })
    expect(historySearchOptions({ agent: 3, cursor: 'DROP', since: Number.NaN, limit: 0 })).toEqual({ limit: 1 })
    // A malformed folder list narrows to nothing, never widens to everything.
    expect(historySearchOptions({ cwdPrefixes: [1, 2] })).toEqual({ cwdPrefixes: [] })
    expect(historySearchOptions('nope')).toEqual({})
  })
})

describe('snippets', () => {
  it('split on the private markers, so literal <mark> stays text', () => {
    expect(snippetParts(`a <mark>b</mark> ${O}c${C} d`)).toEqual([
      { text: 'a <mark>b</mark> ', marked: false },
      { text: 'c', marked: true },
      { text: ' d', marked: false }
    ])
    expect(snippetParts(`${O}open to the end`)).toEqual([{ text: 'open to the end', marked: true }])
  })

  it('cut between parts or inside one, never inside a marker, every mark closed', () => {
    const s = `${'x'.repeat(8)}${O}match${C}tail`
    expect(cutSnippet(s, 100)).toBe(s)
    expect(cutSnippet(s, 11)).toBe(`${'x'.repeat(8)}${O}ma${C}…`)
    expect(cutSnippet(s, 8)).toBe(`${'x'.repeat(7)}…`)
    expect(snippetParts(cutSnippet(s, 11)).map((p) => p.marked)).toEqual([false, true, false])
  })

  it('become <mark> only for answers read as text', () => {
    expect(snippetHtmlMarks(`a ${O}b${C}`)).toBe('a <mark>b</mark>')
  })

  it('render marks as elements and everything else as escaped text', () => {
    const html = renderToStaticMarkup(createElement(HistorySnippet, { text: `<b>x</b> & ${O}hit${C} \u0000` }))
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt; &amp; ')
    expect(html).toContain('<mark class="')
    expect(html.match(/<mark /g)).toHaveLength(1)
    expect(html).toContain('>hit</mark>')
    expect(html).not.toContain('<b>')
  })
})

describe('History screen helpers', () => {
  it('shows the indexing note only while the index builds', () => {
    expect(renderToStaticMarkup(createElement(HistoryIndexingNote, { progress: { indexing: true, indexed: 12, total: 400 } }))).toContain('Indexing… 12/400 · results may be incomplete')
    expect(renderToStaticMarkup(createElement(HistoryIndexingNote, { progress: { indexing: false, indexed: 400, total: 400 } }))).toBe('')
    expect(renderToStaticMarkup(createElement(HistoryIndexingNote, { progress: null }))).toBe('')
  })

  it('searches again when the index finishes or grows a tenth', () => {
    expect(shouldSearchAgain(null, { indexing: false, indexed: 5, total: 5 })).toBe(false)
    expect(shouldSearchAgain({ indexing: true, indexed: 5, total: 400 }, { indexing: false, indexed: 400, total: 400 })).toBe(true)
    expect(shouldSearchAgain({ indexing: true, indexed: 5, total: 400 }, { indexing: true, indexed: 30, total: 400 })).toBe(false)
    expect(shouldSearchAgain({ indexing: true, indexed: 5, total: 400 }, { indexing: true, indexed: 45, total: 400 })).toBe(true)
  })

  it('limits a search to the sessions the filters leave', () => {
    expect(searchScope([item('a'), item('a', { accountId: 'x' }), item('r', { automationId: 'au' })], true)).toEqual(['claude:a'])
  })
})

describe('History search on a paired device', () => {
  function hub(found: (query: unknown, options: unknown) => HistorySearchResult) {
    const { ipc, handlers } = recordIpc({ handle: () => {}, on: () => {} } as unknown as IpcRegistrar)
    ipc.handle('history:search', (_e, query, options) => found(query, options))
    const remote = new RemoteHub({ handlers, profileFolders: async (profileId) => (profileId === 'work' ? ['/work/api'] : []), startMode: async () => null })
    remote.attach({ id: 'phone', capabilities: new Set(['sessions']), emit: () => {} })
    return remote
  }
  const empty = (): HistorySearchResult => ({ entries: [], total: 0, start: 0, errors: [], progress: idle })

  it('is allowed with the sessions capability, scoped to the profile folders whatever the device asks', async () => {
    expect(REMOTE_INVOKES['history:search']).toBe('sessions')
    expect(REMOTE_INVOKES['history:list']).toBeUndefined()
    expect(REMOTE_INVOKES['history:find']).toBeUndefined()
    const asked: unknown[] = []
    const remote = hub((q, o) => (asked.push([q, o]), empty()))
    await remote.invoke('phone', 'history:search', ['deploy', { profileId: 'work', cwdPrefix: '/', keys: ['x'], accountIds: ['y'], limit: 10 }])
    await remote.invoke('phone', 'history:search', ['deploy', { profileId: 'home' }])
    expect(asked).toEqual([
      ['deploy', { limit: 10, cwdPrefixes: ['/work/api'] }],
      ['deploy', { cwdPrefixes: [] }]
    ])
  })

  it('shortens text on part boundaries and resumes at the first match left out', () => {
    const big = 'x'.repeat(5000)
    const result: HistorySearchResult = {
      entries: Array.from({ length: 2000 }, (_, i) => ({ ...item(`s${i}`), title: big, firstPrompt: big, snippet: `${'y'.repeat(398)}${O}match${C}${big}` })),
      total: 5000,
      start: 100,
      nextCursor: '2100',
      errors: [],
      progress: { indexing: false, indexed: 1, total: 1 }
    }
    const slim = remoteHistorySearch(result)
    expect(Buffer.byteLength(JSON.stringify(slim))).toBeLessThan(HISTORY_SEARCH_BYTES + 4096)
    expect(slim.entries.length).toBeGreaterThan(10)
    expect(slim.nextCursor).toBe(String(100 + slim.entries.length))
    expect(snippetParts(slim.entries[0]!.snippet!)).toEqual([
      { text: 'y'.repeat(398), marked: false },
      { text: 'm', marked: true },
      { text: '…', marked: false }
    ])
    // Everything fits: the search's own cursor stays.
    expect(remoteHistorySearch({ ...result, entries: result.entries.slice(0, 2) }).nextCursor).toBe('2100')
  })
})

describe('phone History search', () => {
  const render = (props: Partial<Parameters<typeof HistorySearchBody>[0]>) =>
    renderToStaticMarkup(createElement(HistorySearchBody, { settled: '', data: null, error: '', loadingMore: false, onMore: () => {}, ...props }))
  const match = (fields: Partial<HistoryMatch>): HistoryMatch => ({ ...item('p1'), ...fields })

  it('shows the hint before any search, then no match', () => {
    expect(render({})).toContain('Titles, prompts, folders and branches')
    expect(render({ settled: 'zzz', data: { entries: [] } })).toContain('No session matches.')
  })

  it('says which folders the search covers and what to do when nothing matches', () => {
    const html = render({ settled: 'zzz', data: { entries: [] }, profileName: 'Acme' })
    expect(html).toContain('Only sessions run in Acme’s folders are searched')
  })

  it('shows matches with their snippet, the resume note and Load more', () => {
    const html = render({ settled: 'deploy', data: { entries: [match({ snippet: `the ${O}deploy${C} window` })], nextCursor: '50' } })
    expect(html.match(/data-testid="web-history-row"/g)).toHaveLength(1)
    expect(html).toContain('>deploy</mark>')
    expect(html).toContain('Open it on the computer to resume')
    expect(html).toContain('Show more')
  })

  it('words errors for an offline or silent computer', () => {
    expect(searchErrorKey('offline')).toBe('web.history.offline')
    expect(searchErrorKey(NO_ANSWER_ERROR)).toBe('web.history.noAnswer')
    expect(searchErrorKey('boom')).toBe('web.history.failed')
    expect(render({ settled: 'x', error: 'offline' })).toContain('The computer is offline')
  })
})
