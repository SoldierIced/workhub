import { describe, expect, it, vi } from 'vitest'
import type { TraySession } from '@workhub/core'
import { AppBadge, attentionBadgeCount, badgeLabel, renderBadgeBitmap } from '../src/main/app-badge'

const s = (id: string, extra: Partial<TraySession> = {}): TraySession => ({ id, title: id, state: 'ready', ...extra })

describe('attentionBadgeCount', () => {
  it('counts unread replies, questions and errors, not idle or working sessions', () => {
    expect(
      attentionBadgeCount([
        s('idle'),
        s('working', { state: 'busy' }),
        s('replied', { unseen: 'replied' }),
        s('asks', { awaitingAnswer: true }),
        s('broke', { state: 'error' }),
        s('stopped', { state: 'stopped' })
      ])
    ).toBe(3)
  })

  it('drops to zero once the sessions are seen', () => {
    expect(attentionBadgeCount([s('a', { unseen: 'replied' })])).toBe(1)
    expect(attentionBadgeCount([s('a')])).toBe(0)
    expect(attentionBadgeCount([])).toBe(0)
  })
})

describe('badgeLabel and bitmap', () => {
  it('caps the label at 9+', () => {
    expect([badgeLabel(1), badgeLabel(9), badgeLabel(10), badgeLabel(250)]).toEqual(['1', '9', '9+', '9+'])
  })

  it('draws a red disc with white ink, transparent at the corners', () => {
    const size = 32
    const px = renderBadgeBitmap(3, size)
    expect(px.length).toBe(size * size * 4)
    expect(px[3]).toBe(0) // top-left corner is outside the disc
    const edge = (size * 8 + 3) * 4 // inside the disc, left of the glyph
    expect([px[edge + 2], px[edge + 3]]).toEqual([0xe0, 255])
    let white = 0
    for (let i = 0; i < px.length; i += 4) if (px[i] === 255 && px[i + 1] === 255 && px[i + 2] === 255 && px[i + 3] === 255) white += 1
    expect(white).toBeGreaterThan(20)
    expect(renderBadgeBitmap(3, size).equals(renderBadgeBitmap(3, size))).toBe(true)
    expect(renderBadgeBitmap(3, size).equals(renderBadgeBitmap(4, size))).toBe(false)
  })
})

describe('AppBadge', () => {
  const make = (platform: NodeJS.Platform) => {
    const setBadgeCount = vi.fn()
    const setOverlay = vi.fn()
    return { badge: new AppBadge({ platform, setBadgeCount, setOverlay, describe: (n) => `${n} need you` }), setBadgeCount, setOverlay }
  }

  it('sets the badge count on macOS and Linux, only when it changes', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const { badge, setBadgeCount, setOverlay } = make(platform)
      badge.setCount(2)
      badge.setCount(2)
      badge.setCount(0)
      expect(setBadgeCount.mock.calls).toEqual([[2], [0]])
      expect(setOverlay).not.toHaveBeenCalled()
    }
  })

  it('sets and clears the taskbar overlay on Windows', () => {
    const { badge, setBadgeCount, setOverlay } = make('win32')
    badge.setCount(4)
    expect(setOverlay).toHaveBeenCalledWith({ data: renderBadgeBitmap(4), size: 32 }, '4 need you')
    badge.setCount(0)
    expect(setOverlay).toHaveBeenLastCalledWith(null, '')
    expect(setBadgeCount).not.toHaveBeenCalled()
  })

  it('shows nothing while the setting is off and comes back when it is on', () => {
    const { badge, setBadgeCount } = make('darwin')
    badge.setCount(3)
    badge.setEnabled(false)
    badge.setCount(5)
    expect(setBadgeCount.mock.calls).toEqual([[3], [0]])
    badge.setEnabled(true)
    expect(setBadgeCount).toHaveBeenLastCalledWith(5)
  })

  it('applies again after a refresh (a recreated window lost its overlay)', () => {
    const { badge, setOverlay } = make('win32')
    badge.setCount(1)
    badge.refresh()
    expect(setOverlay).toHaveBeenCalledTimes(2)
  })

  it('treats a bad count as zero', () => {
    const { badge, setBadgeCount } = make('darwin')
    badge.setCount(Number.NaN)
    badge.setCount(-3)
    expect(setBadgeCount.mock.calls).toEqual([[0]])
  })
})
