import { describe, expect, it } from 'vitest'
import {
  buildTargetReviewPrompt,
  clipDiff,
  CONFIG_VERSION,
  defaultReviewer,
  parseCommitRange,
  parsePullRequestInput,
  resolveEffectiveAgents,
  type ResolvedReviewTarget,
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

describe('parsePullRequestInput', () => {
  it('reads numbers and GitHub URLs, and refuses anything else', () => {
    expect(parsePullRequestInput('123')).toEqual({ number: 123 })
    expect(parsePullRequestInput(' #45 ')).toEqual({ number: 45 })
    expect(parsePullRequestInput('https://github.com/acme/pay/pull/7/files?w=1')).toEqual({ number: 7, url: 'https://github.com/acme/pay/pull/7' })
    expect(parsePullRequestInput('https://gitlab.com/acme/pay/-/merge_requests/9')).toMatchObject({ number: 9 })
    expect(parsePullRequestInput('pay#12')).toBeNull()
    expect(parsePullRequestInput('')).toBeNull()
  })
})

describe('parseCommitRange', () => {
  it('reads a range or one commit', () => {
    expect(parseCommitRange('abc123..def456')).toEqual({ from: 'abc123', to: 'def456' })
    expect(parseCommitRange('main...HEAD')).toEqual({ from: 'main', to: 'HEAD' })
    expect(parseCommitRange('HEAD~3')).toEqual({ to: 'HEAD~3' })
  })

  it('refuses option-looking and shell-looking text', () => {
    expect(parseCommitRange('--output=/tmp/x')).toBeNull()
    expect(parseCommitRange('a..$(rm -rf ~)')).toBeNull()
    expect(parseCommitRange('a..b..c')).toBeNull()
    expect(parseCommitRange('')).toBeNull()
  })
})

describe('defaultReviewer', () => {
  it('picks an installed agent of another kind than the session own', () => {
    const r = defaultReviewer(agents, 'claude', { kiro: true, codex: true })
    expect(r?.agent.id).not.toBe('claude')
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

describe('buildTargetReviewPrompt', () => {
  const target: ResolvedReviewTarget = {
    kind: 'pr',
    repoRoot: '/work/wayni/pay',
    repoName: 'pay',
    description: 'the merged pull request #12 "Fix refunds"',
    commits: ['a1b2c3d fix: refunds'],
    diffStat: 'src/refund.ts | +3 -1',
    diff: 'diff --git a/src/refund.ts b/src/refund.ts\n+const x = 1\n',
    pr: { number: 12, url: 'https://github.com/acme/pay/pull/12', title: 'Fix refunds', body: 'Closes PAY-7', state: 'MERGED', baseRefName: 'main', headRefName: 'fix/refunds', mergedAt: '2026-10-01T10:00:00Z' }
  }

  it('holds the goal, session title, repo, target, PR, ticket, diff and the answer format', () => {
    const p = buildTargetReviewPrompt({ target, sessionTitle: 'Refund fixes', goal: 'Make refunds idempotent', ticket: 'PAY-7', inRepo: true, maxDiffChars: 10_000 })
    for (const part of ['Refund fixes', 'Make refunds idempotent', 'PAY-7', '`pay` (`/work/wayni/pay`)', 'merged pull request #12', '#12 Fix refunds', 'https://github.com/acme/pay/pull/12', 'merged 2026-10-01', '`fix/refunds` into `main`', 'Closes PAY-7', 'a1b2c3d fix: refunds', 'src/refund.ts | +3 -1', '+const x = 1', 'file:line', '**blocker**', 'do not edit files'])
      expect(p).toContain(part)
    expect(p).not.toContain('truncated')
  })

  it('cuts a huge diff on a line boundary and says so', () => {
    const diff = Array.from({ length: 2_000 }, (_, i) => `+line ${i}`).join('\n')
    const p = buildTargetReviewPrompt({ target: { ...target, diff }, inRepo: true, maxDiffChars: 1_000 })
    expect(p).toMatch(/the diff was truncated at [\d,]+ of [\d,]+ characters/)
    expect(p).toContain('Read the remaining changed files')
    expect(p).not.toContain('+line 1999')
    const c = clipDiff(diff, 1_000)
    expect(c.truncated).toBe(true)
    expect(c.text.endsWith('\n')).toBe(false)
    expect(c.text.length).toBeLessThanOrEqual(1_000)
  })

  it('outside the PR repository, reviews from the diff and does not claim a folder', () => {
    const p = buildTargetReviewPrompt({ target: { ...target, repoRoot: '', repoName: 'acme/pay' }, inRepo: false, maxDiffChars: 10_000 })
    expect(p).toContain('not a checkout of this pull request')
    expect(p).toContain('- Repository: `acme/pay`\n')
  })

  it('keeps a diff holding backticks inside its fence', () => {
    const p = buildTargetReviewPrompt({ target: { ...target, diff: '+const s = ```x```\n' }, inRepo: true, maxDiffChars: 10_000 })
    expect(p).toContain('````diff\n+const s = ```x```')
  })
})
