import { describe, expect, it } from 'vitest'
import type { TicketChange } from '@workhub/core'
import { FlowAlertWatcher, HealthWatcher, TICKET_LIST_CAP, TICKET_MEMORY_STALE_MS, TicketWatcher, ticketSummaryWords, type TicketWatchState } from '../src/main/watchers'
import { trayText } from '../src/main/tray-text'

type Row = { key: string; title: string; status: string }
const NOW = 1_000 * TICKET_MEMORY_STALE_MS

function memoryStore(initial: TicketWatchState) {
  let saved = initial
  let flushed = 0
  return {
    load: () => saved,
    save: (v: TicketWatchState) => void (saved = v),
    flush: () => void flushed++,
    get value() {
      return saved
    },
    get flushed() {
      return flushed
    }
  }
}

function watcher(initial: TicketWatchState, rows: Row[]) {
  const store = memoryStore(initial)
  const announced: string[] = []
  const summaries: TicketChange[][] = []
  const w = new TicketWatcher({
    activeProfileId: async () => 'p',
    enabled: async () => true,
    list: async () => ({ ok: true as const, value: rows }),
    store,
    announce: (_p, c) => void announced.push(`${c.kind}:${c.key}`),
    announceSummary: (_p, changes) => void summaries.push(changes),
    now: () => NOW
  })
  return { w, store, announced, summaries }
}

const known = (rows: Row[]) => Object.fromEntries(rows.map((r) => [r.key, { status: r.status, title: r.title }]))
const rows = (n: number, status = 'To Do'): Row[] => Array.from({ length: n }, (_, i) => ({ key: `A-${i + 1}`, title: `t${i + 1}`, status }))

describe('ticket watcher memory', () => {
  it('announces the changes of a memory read less than a day ago', async () => {
    const { w, announced, store } = watcher({ profiles: { p: known(rows(2)) }, readAt: { p: NOW - 3_600_000 } }, [{ key: 'A-1', title: 't1', status: 'Done' }])
    await w.tick(true)
    expect(announced).toEqual(['status:A-1', 'left:A-2'])
    expect(store.value.readAt?.['p']).toBe(NOW)
  })

  it('only records when the memory is older than a day or has no read time', async () => {
    for (const readAt of [{ p: NOW - TICKET_MEMORY_STALE_MS - 1 }, undefined]) {
      const { w, announced, summaries, store } = watcher({ profiles: { p: known(rows(2)) }, ...(readAt ? { readAt } : {}) }, [{ key: 'A-1', title: 't1', status: 'Done' }, { key: 'B-1', title: 'new', status: 'To Do' }])
      await w.tick(true)
      expect(announced).toEqual([])
      expect(summaries).toEqual([])
      expect(Object.keys(store.value.profiles['p'] ?? {})).toEqual(['A-1', 'B-1'])
      expect(store.value.readAt?.['p']).toBe(NOW)
    }
  })

  it('folds a burst of changes into one summary', async () => {
    const { w, announced, summaries } = watcher({ profiles: { p: known(rows(6)) }, readAt: { p: NOW - 60_000 } }, rows(6, 'Done'))
    await w.tick(true)
    expect(announced).toEqual([])
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toHaveLength(6)
    const words = ticketSummaryWords(summaries[0]!, trayText('en').t)
    expect(words.title).toBe('6 changes in your tickets')
    expect(words.body).toBe('A-1, A-2, A-3, A-4, A-5, A-6')
  })

  it('never announces a ticket as gone from a list at the cap, and keeps it in memory', async () => {
    const before = rows(TICKET_LIST_CAP)
    // One ticket was pushed out of the full list by a newer one.
    const after = [{ key: 'N-1', title: 'newer', status: 'To Do' }, ...before.slice(0, TICKET_LIST_CAP - 1)]
    const { w, announced, store } = watcher({ profiles: { p: known(before) }, readAt: { p: NOW - 60_000 } }, after)
    await w.tick(true)
    expect(announced).toEqual(['assigned:N-1'])
    expect(store.value.profiles['p']?.[`A-${TICKET_LIST_CAP}`]).toBeDefined()
  })
})

describe('watchers stop', () => {
  it('writes their delayed saves', () => {
    const cooldowns = () => {
      let flushed = 0
      return { load: () => ({}), save: () => undefined, flush: () => void flushed++, get flushed() { return flushed } }
    }
    const health = cooldowns()
    const flow = cooldowns()
    new HealthWatcher({ activeProfileId: async () => null, read: async () => ({ state: 'off' }) as never, alert: () => {}, changed: () => {}, cooldowns: health }).stop()
    new FlowAlertWatcher({ activeProfileId: async () => null, enabled: async () => false, environments: async () => [], maps: async () => [], read: async () => ({}) as never, alert: () => {}, cooldowns: flow }).stop()
    const { w, store } = watcher({ profiles: {} }, [])
    w.stop()
    expect([health.flushed, flow.flushed, store.flushed]).toEqual([1, 1, 1])
  })
})
