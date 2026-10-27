import { describe, expect, it } from 'vitest'
import { translate } from '../src/renderer/i18n/translate'
import { accountOfLabel, originText } from '../src/renderer/lib/continuity'
import { applyEvent, type SessionData } from '../src/renderer/store'

const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) => translate('en', key, params)
const es = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) => translate('es', key, params)

describe('continuity wording', () => {
  it('takes the account out of an agent label', () => {
    expect(accountOfLabel('Claude Code - Laboral')).toBe('Laboral')
    expect(accountOfLabel('Codex')).toBe('Codex')
  })

  it('words a failover by its reason and window, in English and Spanish', () => {
    const view = { label: 'Claude Code - Laboral', accountName: 'Laboral' }
    const from = { kind: 'failover' as const, fromLabel: 'Claude Code - Personal', fromIdentity: 's' }
    expect(originText({ ...from, reason: 'limit', window: '5h' }, view, t)).toBe('Continued in Laboral: Personal reached its 5h limit.')
    expect(originText({ ...from, reason: 'limit' }, view, t)).toBe('Continued in Laboral: Personal reached its usage limit.')
    expect(originText({ ...from, reason: 'ceiling', window: 'weekly' }, view, t)).toBe('Continued in Laboral: Personal is past your weekly ceiling.')
    expect(originText({ ...from, reason: 'manual' }, view, t)).toBe('Continued in Laboral (moved from Personal).')
    expect(originText({ ...from, reason: 'limit', window: '5h' }, view, es)).toBe('Continúa en Laboral: Personal alcanzó su límite de 5h.')
  })

  it('words a hand-off as a summary, not a transcript', () => {
    expect(originText({ kind: 'handoff', fromLabel: 'Claude Code - Personal', fromIdentity: 's' }, { label: 'Codex' }, t)).toMatch(/^Handed off from Claude Code - Personal\. .*summary/)
  })

  it('a usage limit event leaves the chat as it is (the notice comes from main)', () => {
    const s = { view: {}, items: [], monitor: {} } as unknown as SessionData
    expect(applyEvent(s, { sessionId: 'x', type: 'usageLimit', window: '5h' }, () => 1)).toBe(s)
  })
})
