import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FindingPicker } from '../src/renderer/screens/sessions/AiReviewPanel'

afterEach(() => vi.unstubAllGlobals())
const render = (findings: Parameters<typeof FindingPicker>[0]['findings']) => {
  vi.stubGlobal('window', { hub: { platform: 'mac' } })
  return renderToStaticMarkup(createElement(FindingPicker, { loopId: 'l1', findings, review: 'whole answer' }))
}

describe('review loop finding picker', () => {
  it('lists every finding checked, with its severity, and sends them all by default', () => {
    const html = render([
      { id: 'F1', severity: 'major', title: 'src/a.ts:1 — refunds twice', text: 'F1 [major] src/a.ts:1 — refunds twice' },
      { id: 'F2', title: 'naming', text: 'F2 naming' }
    ])
    expect(html).toContain('data-testid="review-loop-pick-F1"')
    expect(html).toContain('data-testid="review-loop-pick-F2"')
    expect(html.match(/checked=""/g)).toHaveLength(2)
    expect(html).toContain('Major')
    expect(html).toContain('Send 2 findings to the author')
    expect(html).toContain('whole answer')
  })

  it('offers the whole review as one item when the reviewer did not number its findings', () => {
    const html = render([])
    expect(html).toContain('data-testid="review-loop-pick-all"')
    expect(html).toContain('Send 1 finding to the author')
  })
})

describe('review loop window', () => {
  it('routes its hash both ways', async () => {
    const { parseReviewLoopHash, reviewLoopWindowHash } = await import('../src/shared/review-loop-window')
    expect(parseReviewLoopHash(reviewLoopWindowHash('loop 1&x'))).toEqual({ loopId: 'loop 1&x' })
    expect(parseReviewLoopHash('#file?path=/x')).toBeNull()
  })

  it('offers the window from the card and opens every finding in it', () => {
    vi.stubGlobal('window', { hub: { platform: 'mac' } })
    const f = [{ id: 'F1', title: 'a', text: 'F1 a' }]
    expect(renderToStaticMarkup(createElement(FindingPicker, { loopId: 'l1', findings: f, review: '' }))).toContain('data-testid="review-loop-open-window"')
    const roomy = renderToStaticMarkup(createElement(FindingPicker, { loopId: 'l1', findings: f, review: '', roomy: true }))
    expect(roomy).not.toContain('review-loop-open-window')
    expect(roomy).toContain('<details class="min-w-0 flex-1" open=""')
  })
})
