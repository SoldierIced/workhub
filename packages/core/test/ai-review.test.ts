import { describe, expect, it } from 'vitest'
import {
  addOpinion,
  aiReviewSettings,
  applyDevReply,
  buildReviewPrompt,
  CONFIG_VERSION,
  configSchema,
  completeRound,
  continueReview,
  decideAutoReview,
  DEFAULT_AI_REVIEW_SETTINGS,
  formatDevMessage,
  manualBlocker,
  markDelivered,
  parseDisputes,
  parseReviewReply,
  pickReviewer,
  readOnlyModeId,
  rejectOption,
  resolveEffectiveAgents,
  setFindingStatus,
  splitLocation,
  startRound,
  stopReview,
  type AiReviewSettings,
  type AutoTriggerInput,
  type BranchReview,
  type ParsedReview,
  type RepoFacts,
  type ReviewPromptInput
} from '../src'
import { claudeA, config, kiroWork, profile } from './fixtures'

const settings: AiReviewSettings = { ...DEFAULT_AI_REVIEW_SETTINGS }

const json = (value: unknown) => `Summary for humans.\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``

const parsed = (over: Partial<ParsedReview> = {}): ParsedReview => ({
  summary: 'ok',
  scope: { assessment: 'proportionate', note: '' },
  findings: [],
  previous: [],
  escalate: { needed: false, reason: '' },
  ...over
})

const finding = (severity: 'blocker' | 'major' | 'minor' | 'nit', title: string, file = 'src/a.ts') => ({ severity, title, file, line: 3, why: 'because', fix: 'do x' })

const start = (prev?: BranchReview, sha = 'sha1', trigger: 'auto' | 'manual' = 'auto') =>
  startRound(prev, { devIdentity: 'dev-1', profileId: 'acme', repoRoot: '/r', branch: 'feat/x', base: 'develop', baseRef: 'origin/develop', sha, trigger, reviewerAgentKey: 'kiro', uncommitted: false, now: 1 }, settings)

describe('AI review settings', () => {
  it('defaults to on and automatic, and the schema fills missing fields without a version bump', () => {
    expect(aiReviewSettings(undefined)).toMatchObject({ enabled: true, auto: true, maxRounds: 3, idleSeconds: 60, baseBranch: 'develop', reviewerAgent: null })
    const parsedConfig = configSchema.parse({ version: CONFIG_VERSION, profiles: [{ id: 'p', name: 'P', aiReview: { maxRounds: 99, idleSeconds: 1 } }] })
    expect(parsedConfig.profiles[0]?.aiReview).toEqual({ ...DEFAULT_AI_REVIEW_SETTINGS, maxRounds: 10, idleSeconds: 10 })
    expect(configSchema.parse({ version: CONFIG_VERSION, profiles: [{ id: 'p', name: 'P' }] }).profiles[0]?.aiReview).toBeUndefined()
  })

  it('picks the configured reviewer when offered with an app mode, else the user order', () => {
    const p = profile({ accountIds: ['claude-a', 'kiro-work'], preferredAgents: ['kiro:kiro-work'] })
    const agents = resolveEffectiveAgents(config({ accounts: [claudeA, kiroWork], profiles: [p] }), 'acme')
    expect(pickReviewer(p, agents)?.key).toBe('kiro:kiro-work')
    expect(pickReviewer({ ...p, aiReview: { ...settings, reviewerAgent: 'claude:claude-a' } }, agents)?.key).toBe('claude:claude-a')
    expect(pickReviewer({ ...p, aiReview: { ...settings, reviewerAgent: 'shell' } }, agents)?.key).toBe('kiro:kiro-work')
    expect(pickReviewer({ ...p, aiReview: { ...settings, reviewerAgent: 'gone' } }, agents)?.key).toBe('kiro:kiro-work')
  })
})

describe('parseReviewReply', () => {
  it('reads the last fenced json block and normalizes fields', () => {
    const text = `${json({ findings: [{ severity: 'x', title: 'old' }] })}\n\nCorrection:\n${json({
      summary: 'Two issues',
      scope: { assessment: 'Scope creep', note: 'asks for a redesign' },
      findings: [
        { severity: 'Critical', title: 'SQL injection', file: 'src/db.ts:42-50', why: 'user input', fix: 'bind params' },
        { severity: 'low', summary: 'naming', path: 'src/a.ts', line: '7', reason: 'unclear', suggestion: 'rename' },
        { severity: 'major' }
      ],
      previous: [{ id: 'f1', status: 'Resolved' }, { id: 'F2', status: 'still open', note: 'same bug' }],
      escalate: { needed: 'true', reason: 'design' }
    })}`
    const r = parseReviewReply(text)!
    expect(r.summary).toBe('Two issues')
    expect(r.scope).toEqual({ assessment: 'scope_creep', note: 'asks for a redesign' })
    expect(r.findings).toEqual([
      { severity: 'blocker', title: 'SQL injection', file: 'src/db.ts', line: 42, why: 'user input', fix: 'bind params' },
      { severity: 'nit', title: 'naming', file: 'src/a.ts', line: 7, why: 'unclear', fix: 'rename' }
    ])
    expect(r.previous).toEqual([{ id: 'F1', status: 'fixed' }, { id: 'F2', status: 'open', note: 'same bug' }])
    expect(r.escalate).toEqual({ needed: true, reason: 'design' })
  })

  it('accepts a bare object, trailing commas and smart quotes', () => {
    const r = parseReviewReply('Here: { “findings”: [ { "severity": "major", "title": "t", "why": "w", }, ], "summary": "s", }')
    expect(r?.findings).toHaveLength(1)
    expect(r?.scope.assessment).toBe('unknown')
    expect(r?.escalate.needed).toBe(false)
  })

  it('handles braces inside strings and returns null when nothing is usable', () => {
    expect(parseReviewReply('{"findings": [{"title": "use {x}", "severity": "nit", "why": "}"}]}')?.findings[0]?.title).toBe('use {x}')
    expect(parseReviewReply('No JSON here, only prose.')).toBeNull()
    expect(parseReviewReply('```json\n{ "summary": "no findings key" }\n```')).toBeNull()
    expect(parseReviewReply('```json\n{ broken\n```')).toBeNull()
  })

  it('splits locations', () => {
    expect(splitLocation('a.ts#L9', undefined)).toEqual({ file: 'a.ts', line: 9 })
    expect(splitLocation('a.ts', 0)).toEqual({ file: 'a.ts' })
    expect(splitLocation('', undefined)).toEqual({})
  })

  it('reads dispute lines', () => {
    expect(parseDisputes('Done.\n- DISPUTE F3: the ticket says so\n**DISPUTE f4** — out of scope\nDISPUTE F3: again')).toEqual([
      { id: 'F3', reason: 'the ticket says so' },
      { id: 'F4', reason: 'out of scope' }
    ])
    expect(parseDisputes('I dispute nothing')).toEqual([])
  })
})

describe('decideAutoReview', () => {
  const repo: RepoFacts = { branch: 'feat/x', headSha: 'sha2', base: 'develop', baseRef: 'origin/develop', ahead: 2, dirty: false }
  const input = (over: Partial<AutoTriggerInput> = {}): AutoTriggerInput => ({ settings, isReviewerSession: false, state: 'ready', idleMs: 61_000, repo, review: undefined, anyRunning: false, ...over })

  it('starts after the debounce on a branch with unreviewed commits', () => {
    expect(decideAutoReview(input())).toEqual({ start: true })
  })

  it.each<[Partial<AutoTriggerInput>, string]>([
    [{ settings: { ...settings, enabled: false } }, 'disabled'],
    [{ settings: { ...settings, auto: false } }, 'manualOnly'],
    [{ isReviewerSession: true }, 'reviewer'],
    [{ state: 'busy' }, 'notIdle'],
    [{ idleMs: null }, 'notIdle'],
    [{ idleMs: 30_000 }, 'debounce'],
    [{ anyRunning: true }, 'running'],
    [{ repo: null }, 'notRepo'],
    [{ repo: { ...repo, branch: null } }, 'detached'],
    [{ repo: { ...repo, baseRef: null } }, 'noBase'],
    [{ repo: { ...repo, branch: 'develop' } }, 'protectedBranch'],
    [{ repo: { ...repo, branch: 'main' } }, 'protectedBranch'],
    [{ repo: { ...repo, branch: 'trunk2', base: 'trunk2' } }, 'protectedBranch'],
    [{ repo: { ...repo, ahead: 0, dirty: true } }, 'noCommits']
  ])('skips %o', (over, reason) => {
    expect(decideAutoReview(input(over))).toEqual({ start: false, reason })
  })

  it('never reviews the same HEAD twice, and respects the review state', () => {
    const r1 = start(undefined, 'sha2')
    expect(decideAutoReview(input({ review: r1 }))).toEqual({ start: false, reason: 'running' })
    const failed = completeRound(r1, { raw: '', parsed: null, error: 'no agent' }, settings, 2)
    expect(decideAutoReview(input({ review: failed }))).toEqual({ start: false, reason: 'alreadyReviewed' })
    expect(decideAutoReview(input({ review: failed, repo: { ...repo, headSha: 'sha3' } }))).toEqual({ start: true })
    const paused = { ...failed, status: 'paused' as const }
    expect(decideAutoReview(input({ review: paused, repo: { ...repo, headSha: 'sha3' } }))).toEqual({ start: false, reason: 'paused' })
    const ready = { ...failed, status: 'ready' as const }
    expect(decideAutoReview(input({ review: ready, repo: { ...repo, headSha: 'sha3' } }))).toEqual({ start: false, reason: 'ready' })
    expect(decideAutoReview(input({ review: { ...failed, status: 'awaitingFixes', pendingDelivery: 'x' }, repo: { ...repo, headSha: 'sha3' } }))).toEqual({ start: false, reason: 'pendingDelivery' })
    const limited = { ...failed, status: 'awaitingFixes' as const, rounds: [...failed.rounds, ...failed.rounds, ...failed.rounds] }
    expect(decideAutoReview(input({ review: limited, repo: { ...repo, headSha: 'sha3' } }))).toEqual({ start: false, reason: 'roundLimit' })
  })

  it('tells why a manual review cannot start', () => {
    expect(manualBlocker(repo, undefined)).toBeNull()
    expect(manualBlocker({ ...repo, ahead: 0 }, undefined)).toBe('noCommits')
    expect(manualBlocker(null, undefined)).toBe('notRepo')
    expect(manualBlocker(repo, start())).toBe('running')
  })
})

describe('review rounds', () => {
  it('round 1 with blockers queues one message for the dev, then verifies and becomes ready', () => {
    let r = start()
    expect(r.rounds).toHaveLength(1)
    r = completeRound(r, { raw: 'x', parsed: parsed({ findings: [finding('minor', 'naming'), finding('blocker', 'crash'), finding('nit', 'typo')] }) }, settings, 5)
    expect(r.status).toBe('awaitingFixes')
    expect(r.findings.map((f) => [f.id, f.severity])).toEqual([['F1', 'minor'], ['F2', 'blocker'], ['F3', 'nit']])
    expect(r.lastReviewedSha).toBe('sha1')
    const msg = r.pendingDelivery!
    expect(msg.indexOf('F2')).toBeLessThan(msg.indexOf('F1'))
    expect(msg.indexOf('F1')).toBeLessThan(msg.indexOf('F3'))
    expect(msg).toContain('DISPUTE F<n>')
    r = markDelivered(r, 6)
    expect(r.pendingDelivery).toBeUndefined()
    expect(r.findings.every((f) => f.sent)).toBe(true)
    r = applyDevReply(r, 'Fixed and committed.', 7)
    expect(r.awaitingDevReply).toBe(false)

    r = start(r, 'sha2')
    expect(r.rounds[1]).toMatchObject({ n: 2, fromSha: 'sha1' })
    r = completeRound(r, { raw: 'y', parsed: parsed({ previous: [{ id: 'F2', status: 'fixed' }, { id: 'F1', status: 'fixed' }] }) }, settings, 8)
    expect(r.status).toBe('ready')
    expect(r.findings.find((f) => f.id === 'F3')?.status).toBe('open')
  })

  it('sends unsent minors once even when nothing blocks', () => {
    const r = completeRound(start(), { raw: 'x', parsed: parsed({ findings: [finding('minor', 'naming')] }) }, settings, 2)
    expect(r.status).toBe('ready')
    expect(r.pendingDelivery).toContain('F1')
    const clean = completeRound(start(), { raw: 'x', parsed: parsed() }, settings, 2)
    expect(clean).toMatchObject({ status: 'ready' })
    expect(clean.pendingDelivery).toBeUndefined()
  })

  it('pauses on reviewer escalation and scope flags, and Continue sends the findings', () => {
    let r = completeRound(start(), { raw: 'x', parsed: parsed({ findings: [finding('major', 'm')], escalate: { needed: true, reason: 'asks for a redesign' } }) }, settings, 2)
    expect(r).toMatchObject({ status: 'paused', escalation: { reason: 'reviewer', detail: 'asks for a redesign' } })
    expect(r.pendingDelivery).toBeUndefined()
    r = continueReview(r, settings, 3)
    expect(r.status).toBe('awaitingFixes')
    expect(r.escalation).toBeUndefined()
    expect(r.pendingDelivery).toContain('F1')
    const creep = completeRound(start(), { raw: 'x', parsed: parsed({ scope: { assessment: 'too_demanding', note: 'too much' } }) }, settings, 2)
    expect(creep.escalation).toMatchObject({ reason: 'reviewer', detail: 'too much' })
  })

  it('pauses at the round limit with blockers open; Continue grants one more round', () => {
    let r = start()
    for (let i = 1; i <= 3; i++) {
      r = completeRound(r, { raw: 'x', parsed: parsed({ findings: i === 1 ? [finding('blocker', 'b')] : [], previous: i > 1 ? [{ id: 'F1', status: 'open' }] : [] }) }, { ...settings, maxRounds: 3 }, i)
      if (i < 3) {
        expect(r.status).toBe(i === 2 ? 'awaitingFixes' : 'awaitingFixes')
        r = start(markDelivered(r, i), `sha${i + 1}`)
      }
    }
    expect(r.status).toBe('paused')
    expect(['maxRounds', 'reopened']).toContain(r.escalation?.reason)
    expect(r.escalation?.detail).toContain('F1 b')
    r = continueReview(r, settings, 9)
    expect(r.extraRounds).toBe(1)
    expect(r.findings[0]?.reopenCount).toBe(0)
    expect(r.status).toBe('awaitingFixes')
  })

  it('escalates a finding reopened twice', () => {
    let r = completeRound(start(), { raw: 'x', parsed: parsed({ findings: [finding('major', 'race')] }) }, { ...settings, maxRounds: 9 }, 1)
    r = start(markDelivered(r, 1), 'sha2')
    r = completeRound(r, { raw: 'x', parsed: parsed({ previous: [{ id: 'F1', status: 'fixed' }], findings: [finding('minor', 'other')] }) }, { ...settings, maxRounds: 9 }, 2)
    expect(r.findings[0]?.status).toBe('fixed')
    r = start(markDelivered(r, 2), 'sha3')
    // Reported again as new (same file and title): back open, counted.
    r = completeRound(r, { raw: 'x', parsed: parsed({ findings: [finding('major', 'Race')] }) }, { ...settings, maxRounds: 9 }, 3)
    expect(r.findings).toHaveLength(2)
    expect(r.findings[0]).toMatchObject({ status: 'open', reopenCount: 1 })
    r = start(markDelivered(r, 3), 'sha4')
    r = completeRound(r, { raw: 'x', parsed: parsed({ previous: [{ id: 'F1', status: 'open' }] }) }, { ...settings, maxRounds: 9 }, 4)
    expect(r).toMatchObject({ status: 'paused', escalation: { reason: 'reopened' } })
  })

  it('pauses when the dev agent disputes a finding', () => {
    let r = markDelivered(completeRound(start(), { raw: 'x', parsed: parsed({ findings: [finding('major', 'a'), finding('minor', 'b')] }) }, settings, 1), 2)
    r = applyDevReply(r, 'DISPUTE F1: required by the API contract\nDISPUTE F9: unknown', 3)
    expect(r).toMatchObject({ status: 'paused', escalation: { reason: 'disputed', detail: 'F1: required by the API contract' } })
    expect(r.findings[0]).toMatchObject({ status: 'disputed', disputeReason: 'required by the API contract' })
    // The user agrees with the dev: dismiss, then continue → nothing blocking left.
    r = setFindingStatus(r, ['F1'], 'dismissed', 4)
    r = continueReview(r, settings, 5)
    expect(r.status).toBe('ready')
  })

  it('keeps unparseable replies raw and forwards them on Continue', () => {
    let r = completeRound(start(), { raw: 'Some prose review', parsed: null }, settings, 2)
    expect(r).toMatchObject({ status: 'paused', escalation: { reason: 'unparsed' }, lastReviewedSha: 'sha1' })
    expect(r.rounds[0]).toMatchObject({ parsed: false, raw: 'Some prose review' })
    r = continueReview(r, settings, 3)
    expect(r.status).toBe('awaitingFixes')
    expect(r.pendingDelivery).toContain('Some prose review')
  })

  it('marks a failed round, and the user can mark findings, add opinions and stop', () => {
    const failed = completeRound(start(), { raw: '', parsed: null, error: 'reviewer exited' }, settings, 2)
    expect(failed.status).toBe('failed')
    expect(failed.rounds[0]?.error).toBe('reviewer exited')
    let r = completeRound(start(), { raw: 'x', parsed: parsed({ findings: [finding('blocker', 'a')] }) }, settings, 2)
    r = markDelivered(r, 3)
    r = setFindingStatus(r, ['F1'], 'dismissed', 4)
    expect(r.status).toBe('ready')
    r = setFindingStatus(r, ['F1'], 'open', 5)
    expect(r.status).toBe('awaitingFixes')
    r = addOpinion(r, '  Keep it small: no refactor.  ', settings, 6)
    expect(r.userNotes).toEqual(['Keep it small: no refactor.'])
    expect(r.pendingDelivery).toContain('Keep it small')
    r = stopReview(r, 7)
    expect(r.status).toBe('stopped')
    expect(r.pendingDelivery).toBeUndefined()
    const again = start(r, 'sha9')
    expect(again.rounds).toHaveLength(1)
    expect(again.findings).toEqual([])
  })

  it('a manual round past the limit grants itself the extra round', () => {
    let r = start()
    for (const sha of ['s2', 's3']) r = start(completeRound(r, { raw: '', parsed: null, error: 'x' }, settings, 1), sha)
    r = completeRound(r, { raw: '', parsed: null, error: 'x' }, settings, 1)
    r = start(r, 's4', 'manual')
    expect(r.rounds).toHaveLength(4)
    expect(r.extraRounds).toBe(1)
  })
})

describe('prompt and message', () => {
  const base: ReviewPromptInput = {
    language: 'en',
    round: 1,
    maxRounds: 3,
    branch: 'feat/x',
    base: 'develop',
    baseRef: 'origin/develop',
    headSha: 'abcdef1234567890',
    mergeBase: '1234567890abcdef',
    commits: ['abc1234 feat: add x'],
    diffStat: ' src/a.ts | 2 +-',
    diff: 'diff --git a/src/a.ts b/src/a.ts\n+x',
    diffTruncated: false,
    ticket: { key: 'ABC-1', title: 'Add x' },
    checklist: '- No console.log\n\n2) Feature flags documented',
    uncommitted: [],
    previous: [],
    userNotes: []
  }

  it('builds round 1 with every required part', () => {
    const p = buildReviewPrompt(base)
    for (const part of ['feat/x', 'develop', 'round 1 of at most 3', 'ABC-1 "Add x"', 'abc1234 feat: add x', 'src/a.ts | 2 +-', '```diff', 'End-to-end flow', 'Security', 'Concurrency', '- No console.log', '- Feature flags documented', '"escalate"', 'read-only checkout', 'abcdef123456']) expect(p).toContain(part)
    expect(p).not.toContain('Previous findings')
    expect(p.trimEnd().endsWith('```')).toBe(true)
  })

  it('builds round 2 with the delta, previous findings, user notes, truncation and uncommitted files', () => {
    const p = buildReviewPrompt({
      ...base,
      round: 2,
      fromSha: '9999999999999999',
      ticket: undefined,
      diffTruncated: true,
      uncommitted: ['src/b.ts'],
      userNotes: ['No refactors'],
      previous: [{ id: 'F2', severity: 'major', title: 'race', file: 'a.ts', line: 3, why: '', fix: '', status: 'disputed', disputeReason: 'by design', round: 1, reopenCount: 0, sent: true }]
    })
    for (const part of ['Round 2', 'since `999999999999`', 'F2 [major] race (a.ts:3) — author disputes: by design', '> No refactors', 'was cut at a size limit', 'src/b.ts', 'No ticket is linked']) expect(p).toContain(part)
  })

  it('has a Spanish template with the same structure', () => {
    const p = buildReviewPrompt({ ...base, language: 'es' })
    expect(p).toContain('ronda de revisión 1')
    expect(p).toContain('"findings"')
  })

  it('formats the dev message: blockers and majors first, with location, why and fix', () => {
    const r = completeRound(start(), { raw: 'x', parsed: parsed({ findings: [finding('nit', 'n'), finding('major', 'm'), finding('blocker', 'b')] }) }, settings, 2)
    const msg = formatDevMessage({ language: 'es', branch: 'feat/x', base: 'develop', round: 1, maxRounds: 3, findings: r.findings })
    expect(msg).toContain('3 por corregir')
    expect(msg.indexOf('F3 [bloqueante]')).toBeLessThan(msg.indexOf('F2 [mayor]'))
    expect(msg.indexOf('F2 [mayor]')).toBeLessThan(msg.indexOf('F1 [detalle]'))
    expect(msg).toContain('`src/a.ts:3`')
  })
})

describe('read-only helpers', () => {
  it('picks the most read-only mode and the reject option', () => {
    expect(readOnlyModeId([{ id: 'default', name: 'Default' }, { id: 'plan', name: 'Plan' }])).toBe('plan')
    expect(readOnlyModeId([{ id: 'auto', name: 'a' }, { id: 'read-only', name: 'r' }, { id: 'plan', name: 'p' }])).toBe('read-only')
    expect(readOnlyModeId([{ id: 'kiro_default', name: 'k' }])).toBeUndefined()
    expect(rejectOption([{ optionId: 'a', kind: 'allow_once' }, { optionId: 'r', kind: 'reject_always' }, { optionId: 'o', kind: 'reject_once' }])).toBe('o')
    expect(rejectOption([{ optionId: 'a', kind: 'allow_once' }])).toBeUndefined()
  })
})
