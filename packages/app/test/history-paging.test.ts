import { describe, expect, it } from 'vitest'
import { HISTORY_PAGE, pageGroups } from '../src/renderer/screens/HistoryScreen'

const group = (folder: string, n: number) => ({ folder, entries: Array.from({ length: n }, (_, i) => `${folder}-${i}`) })

describe('History paging', () => {
  it('renders every row when the history fits in one page', () => {
    const page = pageGroups([group('a', 3), group('b', 2)], HISTORY_PAGE)
    expect(page.hidden).toBe(0)
    expect(page.groups.map((g) => [g.folder, g.entries.length, g.total])).toEqual([
      ['a', 3, 3],
      ['b', 2, 2]
    ])
  })

  it('cuts the folder that crosses the limit and counts the rest as hidden, keeping each folder total', () => {
    const page = pageGroups([group('a', 4), group('b', 5), group('c', 2)], 6)
    expect(page.groups.map((g) => [g.folder, g.entries.length, g.total])).toEqual([
      ['a', 4, 4],
      ['b', 2, 5]
    ])
    expect(page.groups[1]!.entries).toEqual(['b-0', 'b-1'])
    expect(page.hidden).toBe(5)
  })

  it('shows nothing at a zero limit and never a negative count', () => {
    expect(pageGroups([group('a', 2)], 0)).toEqual({ groups: [], hidden: 2 })
    expect(pageGroups([], -5)).toEqual({ groups: [], hidden: 0 })
  })
})
