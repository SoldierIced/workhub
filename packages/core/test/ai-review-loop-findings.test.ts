import { describe, expect, it } from 'vitest'
import { buildAuthorFinalPrompt, buildAuthorFixPrompt, buildLoopReviewerPrompt, buildReReviewPrompt, parseLoopFindings, setAsideItems } from '../src/ai-review/author-loop'

const REVIEW = [
  'The change adds a retry to the payment callback. Overall sound, two problems.',
  '',
  '**Evidence**: read src/callback.ts in full.',
  '',
  '## Findings',
  '- **F1** [major] src/callback.ts:42 — the retry has no upper bound',
  '  A failing gateway loops forever. Fix: cap it at 3.',
  '- F2 (minor) src/callback.test.ts:10 — no test for the timeout path',
  '### F3 nit docs/README.md:5 — typo',
  '',
  '## Checklist',
  'C1. OK, src/callback.ts',
  'C5. FINDING F1',
  '',
  'VERDICT: CHANGES_REQUESTED'
].join('\n')

describe('parseLoopFindings', () => {
  it('reads each numbered finding with its severity, title and full text, and stops at the checklist', () => {
    const findings = parseLoopFindings(REVIEW)
    expect(findings.map((f) => [f.id, f.severity, f.title])).toEqual([
      ['F1', 'major', 'src/callback.ts:42 — the retry has no upper bound'],
      ['F2', 'minor', 'src/callback.test.ts:10 — no test for the timeout path'],
      ['F3', 'nit', 'docs/README.md:5 — typo']
    ])
    expect(findings[0]!.text).toContain('Fix: cap it at 3.')
    expect(findings[2]!.text).not.toContain('C5')
  })

  it('finds nothing in a review without numbered findings, and keeps the first of a repeated id', () => {
    expect(parseLoopFindings('Looks fine.\nVERDICT: APPROVED')).toEqual([])
    expect(parseLoopFindings('F1 [major] a.ts:1 — one\nF1 [minor] b.ts:2 — again').map((f) => f.title)).toEqual(['a.ts:1 — one'])
  })

  it('asks the reviewer to number its findings', () => {
    expect(buildLoopReviewerPrompt({ brief: 'b', maxRounds: 3 })).toContain('`F<n> [severity] path/to/file:line')
  })
})

describe('the user picks the findings', () => {
  const findings = parseLoopFindings(REVIEW)
  const selection = { findings, keep: ['F1', 'F3'], note: 'Skip the test for now; we add it in another PR.' }

  it('sends only the kept findings, names the ones set aside and adds the note', () => {
    const prompt = buildAuthorFixPrompt({ review: REVIEW, reviewer: 'Codex', round: 1, maxRounds: 3, selection })
    expect(prompt).toContain('the retry has no upper bound')
    expect(prompt).toContain('docs/README.md:5')
    expect(prompt).not.toContain('no test for the timeout path\n')
    expect(prompt).toContain('set these findings aside: do not fix them. F2 (src/callback.test.ts:10')
    expect(prompt).toContain('<user-note>\nSkip the test for now')
    expect(prompt).not.toContain('VERDICT')
  })

  it('says when nothing was kept, and sends the whole review when the findings were not numbered', () => {
    expect(buildAuthorFixPrompt({ review: REVIEW, reviewer: 'Codex', round: 1, maxRounds: 3, selection: { findings, keep: [] } })).toContain('None of the findings was kept.')
    const whole = buildAuthorFinalPrompt({ review: 'Unnumbered problems here.', reviewer: 'Codex', outcome: 'maxRounds', round: 3, maxRounds: 3, selection: { findings: [], keep: ['all'] } })
    expect(whole).toContain('<review>\nUnnumbered problems here.\n</review>')
  })

  it('keeps today\'s prompt without a selection', () => {
    expect(buildAuthorFixPrompt({ review: REVIEW, reviewer: 'Codex', round: 1, maxRounds: 3 })).toContain(`<review>\n${REVIEW}\n</review>`)
  })

  it('tells the reviewer what the user set aside and their note', () => {
    const prompt = buildReReviewPrompt({ reply: 'Fixed F1.', round: 2, maxRounds: 3, setAside: { items: ['Round 1 F2: src/a.ts:3 — naming'], note: 'Test later.' } })
    expect(prompt).toContain('set aside these findings of yours')
    expect(prompt).toContain('- Round 1 F2: src/a.ts:3 — naming')
    expect(prompt).toContain('from F1 again')
    expect(prompt).toContain('<user-note>\nTest later.')
    expect(buildReReviewPrompt({ reply: 'x', round: 2, maxRounds: 3 })).not.toContain('set aside')
  })

  it('names set-aside findings by round and title, and a dropped unnumbered review as a whole', () => {
    const findings = parseLoopFindings('F1 [major] a.ts:1 — one\nF2 [nit] b.ts:2 — two')
    expect(setAsideItems({ findings, keep: ['F1'] }, 2)).toEqual(['Round 2 F2: b.ts:2 — two'])
    expect(setAsideItems({ findings: [], keep: [] }, 3)).toEqual(['Everything in your round 3 review.'])
    expect(setAsideItems({ findings: [], keep: ['all'] }, 3)).toEqual([])
  })

  it('reads a re-review: status lines of old findings are not new ones, and Evidence: inside a finding does not cut it', () => {
    const review = [
      '- F1: fixed, verified in a.ts:12.',
      '- F2: still open.',
      '',
      'F1 [major] c.ts:4 — new problem',
      'Evidence: c.ts:4 calls it twice.',
      'Fix: call it once.',
      '',
      '## Checklist',
      '1. OK',
      'VERDICT: CHANGES_REQUESTED'
    ].join('\n')
    const found = parseLoopFindings(review)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ id: 'F1', severity: 'major', title: 'c.ts:4 — new problem' })
    expect(found[0]!.text).toContain('Fix: call it once.')
    expect(found[0]!.text).not.toContain('Checklist')
  })
})
