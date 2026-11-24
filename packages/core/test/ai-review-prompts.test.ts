import { describe, expect, it } from 'vitest'
import {
  addOpinion,
  aiReviewSettings,
  briefPromptOf,
  buildAuthorFinalPrompt,
  buildAuthorFixPrompt,
  buildLoopReviewerPrompt,
  buildReReviewPrompt,
  buildReviewPrompt,
  DEFAULT_REVIEW_BRIEF_PROMPT,
  formatDevMessage,
  formatOpinionMessage,
  formatRawDevMessage,
  type ReviewPromptInput
} from '../src'

const finding = { id: 'F1', severity: 'major' as const, title: 'a', file: 'src/a.ts', line: 3, why: 'w', fix: 'f', status: 'open' as const, round: 1, reopenCount: 0, sent: false }
const prInput: ReviewPromptInput = {
  language: 'en',
  round: 2,
  maxRounds: 3,
  branch: 'feat/x',
  base: 'develop',
  baseRef: 'origin/develop',
  headSha: 'abcdef1234567890',
  mergeBase: '1234567890abcdef',
  fromSha: 'fedcba0987654321',
  commits: [],
  diffStat: '',
  diffFile: '.workhub-review/changes.diff',
  diffTruncated: false,
  checklist: '',
  uncommitted: [],
  previous: [],
  userNotes: []
}

describe('editable AI review prompts', () => {
  it('briefPromptOf: the profile text, else the app-wide text, else the default', () => {
    expect(briefPromptOf({ briefPrompt: '' })).toBe(DEFAULT_REVIEW_BRIEF_PROMPT)
    expect(briefPromptOf({ briefPrompt: '  ' }, { 'review.briefAsk': 'App-wide' })).toBe('App-wide')
    expect(briefPromptOf({ briefPrompt: 'Mine' }, { 'review.briefAsk': 'App-wide' })).toBe('Mine')
    expect(briefPromptOf(aiReviewSettings(undefined), {})).toBe(DEFAULT_REVIEW_BRIEF_PROMPT)
  })

  it('the loop reviewer prompt uses the role text and keeps the guard, the brief fence, the method and the format', () => {
    const p = buildLoopReviewerPrompt({ brief: 'Repos: /work/x', sessionTitle: 'Refunds', maxRounds: 4 }, { 'review.loopRole': 'Look at {sessionTitle} ({maxRounds} rounds).\n{brief}' })
    expect(p.startsWith('Look at Refunds (4 rounds).\n')).toBe(true)
    expect(p).toContain('your only output is the review.')
    expect(p).toContain('<review-brief>\nRepos: /work/x\n</review-brief>')
    expect(p).toContain('VERDICT: APPROVED')
    expect(p).toContain('## Checklist')
    expect(p).not.toContain('You are a senior engineer')
  })

  it('method and checklist overrides reach the loop reviewer and the re-review', () => {
    const o = { 'review.method': 'MY METHOD', 'review.checklist': 'MY CHECKLIST' }
    for (const p of [buildLoopReviewerPrompt({ brief: 'b', maxRounds: 2 }, o), buildReReviewPrompt({ reply: 'r', round: 2, maxRounds: 2 }, o)]) {
      expect(p).toContain('MY METHOD')
      expect(p).toContain('MY CHECKLIST')
      expect(p).not.toContain('## How to review')
      expect(p).toContain('VERDICT: APPROVED')
    }
  })

  it('the re-review text is replaced; the author reply and the answer format stay', () => {
    const p = buildReReviewPrompt({ reply: 'Fixed F1.', round: 2, maxRounds: 3 }, { 'review.loopReReview': 'Again (round {round}/{maxRounds}).' })
    expect(p).toContain('Again (round 2/3).')
    expect(p).toContain('<author-reply>\nFixed F1.\n</author-reply>')
    expect(p).not.toContain('Review again: look at')
    expect(p).toContain('This is round 2 of at most 3')
  })

  it('the author fix prompts: each wording has its own text, the findings stay', () => {
    const o = { 'review.loopAuthorFix': 'FIX {reviewer} {round}/{maxRounds}', 'review.loopAuthorFixSelected': 'PICKED {reviewer}' }
    const plain = buildAuthorFixPrompt({ review: 'F1 a.ts', reviewer: 'Codex', round: 1, maxRounds: 3 }, o)
    expect(plain).toBe('FIX Codex 1/3\n\n<review>\nF1 a.ts\n</review>')
    const selection = { findings: [{ id: 'F1', title: 'a', text: 'F1 a' }], keep: ['F1'] }
    const picked = buildAuthorFixPrompt({ review: 'F1 a', reviewer: 'Codex', round: 1, maxRounds: 3, selection }, o)
    expect(picked.startsWith('PICKED Codex\n\n')).toBe(true)
    expect(picked).toContain('<review>\nF1 a\n</review>')
  })

  it('the author final prompts: approved and out of rounds', () => {
    const o = { 'review.loopAuthorApproved': 'OK {reviewer} {round}', 'review.loopAuthorOutOfRounds': 'NO {reviewer} {maxRounds}' }
    expect(buildAuthorFinalPrompt({ review: 'x', reviewer: 'K', outcome: 'approved', round: 2, maxRounds: 3 }, o)).toBe('OK K 2\n\n<review>\nx\n</review>')
    expect(buildAuthorFinalPrompt({ review: 'x', reviewer: 'K', outcome: 'maxRounds', round: 3, maxRounds: 3 }, o)).toBe('NO K 3\n\n<review>\nx\n</review>')
  })

  it('the branch review prompt: round and delta texts, the language follows the table without an override', () => {
    const o = { 'review.prRound': 'ROUND {round} of {branch}', 'review.prRoundDelta': 'DELTA since {fromSha}' }
    const p = buildReviewPrompt(prInput, o)
    expect(p.startsWith('ROUND 2 of feat/x\n\nDELTA since fedcba098765\n\n')).toBe(true)
    expect(p).toContain('read-only checkout')
    expect(p).toContain('"summary": "one paragraph"')
    expect(buildReviewPrompt({ ...prInput, language: 'es' }, { 'review.prRound': 'ROUND' })).toContain('Responde todo en español')
    expect(buildReviewPrompt({ ...prInput, language: 'es' })).toContain('Eres el revisor de código de la rama `feat/x`')
    expect(buildReviewPrompt({ ...prInput, language: 'es' })).toContain('Ronda 2: el autor subió commits nuevos')
  })

  it('the message to the dev: the opening is editable, FIXED and DISPUTE stay (also in the raw and Spanish forms)', () => {
    const o = { 'review.prDevMessage': 'Please fix.' }
    const base = { language: 'en' as const, branch: 'b', base: 'd', round: 1, maxRounds: 3, findings: [finding] }
    const msg = formatDevMessage(base, o)
    expect(msg).toContain('Please fix. For each finding you fixed')
    expect(msg).toContain('`FIXED F<n>:')
    expect(msg).toContain('`DISPUTE F<n>:')
    expect(msg).not.toContain('Fix them, run the tests')
    expect(formatRawDevMessage('es', 'raw reply', o)).toContain('Please fix. Por cada hallazgo que corregiste')
    expect(formatDevMessage({ ...base, language: 'es' })).toContain('Corrígelos, ejecuta las pruebas')
  })

  it('the opinion opening is editable and the opinion stays', () => {
    expect(formatOpinionMessage('en', ' It is fine ', { 'review.prOpinion': 'The lead says:' })).toBe('The lead says:\n\nIt is fine')
    expect(formatOpinionMessage('es', 'ok')).toBe('Una nota del usuario sobre esta revisión:\n\nok')
    const review = { id: 'r', userNotes: [], updatedAt: 0 } as never
    expect(addOpinion(review, 'ok', { language: 'en' }, 1, { 'review.prOpinion': 'Lead:' }).pendingDelivery).toBe('Lead:\n\nok')
  })
})
