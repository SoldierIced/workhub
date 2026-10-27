import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { creditSpend } from '@workhub/core'
import { kiroChatCreditEntry, kiroCliCreditEntries, readKiroCreditEntries } from '../src/transcript-kiro'

const kiroDir = join(import.meta.dirname, 'fixtures', 'kiro-home')
const iso = (s: string) => Date.parse(s)

describe('Kiro credits per turn', () => {
  it('reads each ACP turn by its end time, else the session update time', () => {
    const text = JSON.stringify({
      updated_at: '2026-10-27T20:00:00Z',
      session_state: {
        conversation_metadata: {
          user_turn_metadatas: [
            { end_timestamp: '2026-10-27T19:48:50.231240Z', metering_usage: [{ value: 1.03, unit: 'credit', unitPlural: 'credits' }] },
            { metering_usage: [{ value: 0.5, unit: 'credit' }, { value: 0.25, unit: 'credit' }] },
            { end_timestamp: '2026-10-27T19:50:00Z', metering_usage: [] }
          ]
        }
      }
    })
    expect(kiroCliCreditEntries(text)).toEqual([
      { at: iso('2026-10-27T19:48:50.231Z'), credits: 1.03 },
      { at: iso('2026-10-27T20:00:00Z'), credits: 0.75 }
    ])
    expect(kiroCliCreditEntries('{broken')).toEqual([])
  })

  it('reads a chat session usage_summary line and ignores the rest', () => {
    const line = JSON.stringify({ timestamp: '2026-10-01T12:00:23.000Z', payload: { type: 'usage_summary', promptTurnSummaries: [{ usage: 1.5 }, { usage: 0.5 }] } })
    expect(kiroChatCreditEntry(line)).toEqual({ at: iso('2026-10-01T12:00:23.000Z'), credits: 2 })
    expect(kiroChatCreditEntry(JSON.stringify({ timestamp: '2026-10-01T12:00:00Z', payload: { type: 'user', content: 'usage_summary' } }))).toBeNull()
  })

  it('collects both layouts from the sessions folder, oldest first, from a start time', async () => {
    const all = await readKiroCreditEntries({ kiroDir, since: 0 })
    expect(all.map((e) => [new Date(e.at).toISOString(), e.credits])).toEqual([
      ['2026-10-01T12:00:23.000Z', 1.5],
      ['2026-10-01T12:10:00.000Z', 0.5],
      ['2026-10-02T09:20:00.000Z', 0.75],
      ['2026-10-02T09:20:00.000Z', 0.125]
    ])
    const total = all.reduce((a, e) => a + e.credits, 0)
    // Chat: 1.5 + 0.5; ACP session 1: 0.75 + 0.125 (both at its updated_at).
    expect(total).toBeCloseTo(2.875, 8)

    const later = await readKiroCreditEntries({ kiroDir, since: iso('2026-10-02T00:00:00Z') })
    expect(later.reduce((a, e) => a + e.credits, 0)).toBeCloseTo(0.875, 8)

    // Spent per day and week from those entries.
    const spend = creditSpend(all, iso('2026-10-02T12:00:00Z'))
    expect(spend.week).toBeCloseTo(2.875, 8)
    expect(await readKiroCreditEntries({ kiroDir: join(kiroDir, 'missing'), since: 0 })).toEqual([])
  })
})
