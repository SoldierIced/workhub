import { describe, expect, it } from 'vitest'
import {
  afterVerdict,
  aiReviewSettings,
  briefPromptOf,
  buildAuthorFixPrompt,
  buildLoopReviewerPrompt,
  buildReReviewPrompt,
  CONFIG_VERSION,
  DEFAULT_REVIEW_BRIEF_PROMPT,
  defaultReviewer,
  extractReviewBrief,
  parseReviewVerdict,
  resolveEffectiveAgents,
  type WorkhubConfig
} from '../src'

const config: WorkhubConfig = {
  version: CONFIG_VERSION,
  connections: [],
  agents: [],
  accounts: [
    { id: 'personal', agentId: 'claude', name: 'Personal' },
    { id: 'work', agentId: 'claude', name: 'Work' }
  ],
  profiles: [{ id: 'p', name: 'P', connections: {}, accountIds: ['personal', 'work'], modules: { flows: false, health: false, chatWatcher: false, automations: false } }],
  activeProfileId: 'p'
}
const agents = resolveEffectiveAgents(config, 'p')

describe('extractReviewBrief', () => {
  it('takes the text between the markers, the last block when there are several', () => {
    expect(extractReviewBrief('Sure.\n<review-brief>\n# Repos\n- /work/pay on feat/x\n</review-brief>\nDone.')).toBe('# Repos\n- /work/pay on feat/x')
    expect(extractReviewBrief('<review-brief>draft</review-brief> then <review-brief>final</review-brief>')).toBe('final')
  })

  it('reads an unclosed block up to the end', () => {
    expect(extractReviewBrief('Here:\n<review-brief>\nall of it')).toBe('all of it')
  })

  it('falls back to the whole reply without markers, and to nothing when it is empty', () => {
    expect(extractReviewBrief('  Repos: /work/pay, feat/x. Diff: git -C /work/pay diff main...feat/x  ')).toBe('Repos: /work/pay, feat/x. Diff: git -C /work/pay diff main...feat/x')
    expect(extractReviewBrief('<review-brief></review-brief>')).toBeNull()
    expect(extractReviewBrief('  \n')).toBeNull()
  })
})

describe('parseReviewVerdict', () => {
  it('reads the last verdict line, in bold or code too', () => {
    expect(parseReviewVerdict('Looks good.\nVERDICT: APPROVED')).toBe('approved')
    expect(parseReviewVerdict('1. major: x.ts:3 …\n\n**VERDICT: CHANGES_REQUESTED**')).toBe('changesRequested')
    expect(parseReviewVerdict('`VERDICT: changes requested`')).toBe('changesRequested')
    expect(parseReviewVerdict('First I thought VERDICT: CHANGES_REQUESTED, but\nVERDICT: APPROVED')).toBe('approved')
  })

  it('is null without a verdict line', () => {
    expect(parseReviewVerdict('I approve this change.')).toBeNull()
  })
})

describe('afterVerdict', () => {
  it('ends approved, ends at the round limit, else goes to the author', () => {
    expect(afterVerdict('approved', 3, 3)).toBe('approved')
    expect(afterVerdict('changesRequested', 1, 3)).toBe('fixing')
    expect(afterVerdict(null, 1, 3)).toBe('fixing')
    expect(afterVerdict('changesRequested', 3, 3)).toBe('maxRounds')
  })
})

describe('loop prompts', () => {
  it('asks the author for every repo, branch, PR and diff command, between markers', () => {
    for (const part of ['repository', 'branch', 'pull request', 'git -C <path> diff', 'gh pr diff', '<review-brief>', '</review-brief>']) expect(DEFAULT_REVIEW_BRIEF_PROMPT).toContain(part)
    expect(briefPromptOf(aiReviewSettings(undefined))).toBe(DEFAULT_REVIEW_BRIEF_PROMPT)
    expect(briefPromptOf({ briefPrompt: 'Mine' })).toBe('Mine')
  })

  it('gives the reviewer the brief, read-only rules, severities with file:line and the verdict line', () => {
    const p = buildLoopReviewerPrompt({ brief: 'Repos: /work/pay', sessionTitle: 'Refunds in pay\nmore', maxRounds: 3 })
    expect(p.split('\n')[0]).toBe('Review: Refunds in pay')
    for (const part of ['Repos: /work/pay', 'do not edit files', 'file:line', 'VERDICT: APPROVED', 'VERDICT: CHANGES_REQUESTED', 'round 1 of at most 3']) expect(p).toContain(part)
  })

  it('wraps the findings for the author and the answer for the re-review, naming the last round', () => {
    const fix = buildAuthorFixPrompt({ review: 'major: a.ts:1', reviewer: 'Kiro', round: 1, maxRounds: 2 })
    expect(fix).toContain('Review round 1 of 2 by Kiro')
    expect(fix).toContain('<review>\nmajor: a.ts:1\n</review>')
    const again = buildReReviewPrompt({ reply: 'Fixed a.ts:1 in abc123', round: 2, maxRounds: 2 })
    expect(again).toContain('<author-reply>\nFixed a.ts:1 in abc123\n</author-reply>')
    expect(again).toContain('round 2 of 2, the last one')
    expect(buildReReviewPrompt({ reply: ' ', round: 2, maxRounds: 3 })).toContain('(the author replied with no text)')
  })
})

describe('defaultReviewer', () => {
  it('picks an installed agent of another kind than the session own', () => {
    const r = defaultReviewer(agents, 'claude', { kiro: true, codex: true })
    expect(r?.agent.id).not.toBe('claude')
    // Claude over ACP is the same kind as native Claude.
    expect(defaultReviewer(agents, 'claude', {}, ['claude-acp', 'kiro'])?.key).toBe('kiro')
    expect(defaultReviewer(agents, 'claude-acp', {}, ['claude:work', 'codex'])?.key).toBe('codex')
  })

  it('follows the preferred order among other agents and skips uninstalled ones', () => {
    expect(defaultReviewer(agents, 'claude', { kiro: false }, ['kiro', 'codex'])?.key).toBe('codex')
    expect(defaultReviewer(agents, 'kiro', {}, ['kiro', 'claude:work'])?.key).toBe('claude:work')
  })

  it('falls back to the same agent when nothing else is installed', () => {
    const installed = Object.fromEntries(agents.map((a) => [a.agent.id, a.agent.id === 'claude']))
    expect(defaultReviewer(agents, 'claude', installed)?.agent.id).toBe('claude')
  })
})
