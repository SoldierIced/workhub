import { describe, expect, it } from 'vitest'
import type { HistoryMessage } from '@workhub/core'
import { HISTORY_PAGE_BYTES, HISTORY_PAGE_MAX, pageHistory, slimMessage } from '../src/main/remote'

const said = (n: number, size = 10): HistoryMessage[] => Array.from({ length: n }, (_, i) => ({ kind: 'agent', text: `${i}`.padEnd(size, '.') }))
const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v))

describe('paging a session\'s conversation for a paired device', () => {
  it('answers the newest messages first, then the page before `start`, down to the first message', () => {
    const all = said(HISTORY_PAGE_MAX + 20)
    const last = pageHistory(all)
    expect(last).toMatchObject({ start: 20, total: all.length })
    expect(last.messages).toHaveLength(HISTORY_PAGE_MAX)
    expect(last.messages.at(-1)).toEqual(all.at(-1))
    const earlier = pageHistory(all, last.start)
    expect(earlier.start).toBe(0)
    expect(earlier.messages).toEqual(all.slice(0, 20))
    expect(pageHistory(all, 0)).toEqual({ messages: [], start: 0, total: all.length })
  })

  it('keeps a page under its byte budget, whatever the messages weigh', () => {
    const page = pageHistory(said(100, 8_000))
    expect(bytes(page.messages)).toBeLessThanOrEqual(HISTORY_PAGE_BYTES + 1024)
    expect(page.start).toBeGreaterThan(0)
    expect(page.messages.length).toBeGreaterThan(5)
  })

  it('takes a bad cursor as the nearest valid one', () => {
    const all = said(3)
    expect(pageHistory(all, 99).start).toBe(0)
    expect(pageHistory(all, -4)).toMatchObject({ messages: [], start: 0 })
  })

  it('leaves out image bytes and the bulk of oversized messages', () => {
    const image = { mediaType: 'image/png', data: 'A'.repeat(50_000) }
    expect(slimMessage({ kind: 'user', text: 'look', images: 1, imageData: [image] })).toEqual({ kind: 'user', text: 'look', images: 1 })
    const tool = slimMessage({ kind: 'tool', id: 't', title: 'Ran the tests', result: { text: 'x'.repeat(60_000) } })
    expect(tool).toEqual({ kind: 'tool', id: 't', title: 'Ran the tests' })
    const long = slimMessage({ kind: 'agent', text: 'y'.repeat(60_000) })
    expect(bytes(long)).toBeLessThan(13_000)
    const small: HistoryMessage = { kind: 'tool', id: 't', title: 'Read', view: { kind: 'read', path: 'a.ts' } }
    expect(slimMessage(small)).toBe(small)
  })
})
