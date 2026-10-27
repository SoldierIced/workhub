import { describe, expect, it, vi } from 'vitest'
import { NO_CAPABILITIES, type AgentDefinition, type EffectiveAgent } from '@workhub/core'
import type { HistoryItem, StartSessionInput } from '../src/shared/api'
import type { PullRequestTarget } from '../src/shared/links-api'
import { parseWorktrees } from '../src/main/links'
import { en } from '../src/renderer/i18n/en'
import { placeholders } from '../src/renderer/i18n/translate'
import { linksEn } from '../src/renderer/i18n/links.en'
import { linksEs } from '../src/renderer/i18n/links.es'
import { agentForDraft, reviewPrompt, runIntent, ticketPrompt, type IntentDeps } from '../src/renderer/lib/links'
import type { SessionData } from '../src/renderer/store'

const pr: PullRequestTarget = {
  provider: 'github',
  owner: 'acme',
  repo: 'billing-api',
  number: 133,
  url: 'https://github.com/acme/billing-api/pull/133',
  title: 'DEMO-230 Retry failed webhooks',
  branch: 'feat/demo-230-webhook-retry',
  base: 'main',
  author: 'ana'
}

const agent = (id: string, appMode = true): EffectiveAgent => ({
  key: id,
  account: null,
  label: id,
  agent: { id, name: id, command: id, adapter: id === 'claude' ? 'native' : 'acp', capabilities: { ...NO_CAPABILITIES, appMode } } as AgentDefinition
})

const live = (id: string, over: Partial<SessionData['view']> = {}, monitor: SessionData['monitor'] = {}): SessionData =>
  ({ view: { id, label: id, state: 'ready', ...over }, items: [], monitor }) as unknown as SessionData

function harness(over: Partial<IntentDeps> = {}) {
  const starts: StartSessionInput[] = []
  const drafts: [string, string][] = []
  const deps: IntentDeps = {
    locale: 'en',
    agents: [agent('claude'), agent('shell', false)],
    sessions: [],
    checkouts: async () => [
      { path: '/w/storefront', remote: 'git@github.com:acme/storefront.git', branch: 'main' },
      { path: '/w/billing', remote: 'git@github.com:acme/billing-api.git', branch: 'main' },
      { path: '/w/billing-wt', remote: 'git@github.com:acme/billing-api.git', branch: pr.branch }
    ],
    providers: async () => [{ provider: 'jira', projectKeys: ['DEMO'] }],
    defaultCwd: async () => '/home/me',
    model: () => undefined,
    start: async (input) => (starts.push(input), { id: `new-${starts.length}` }),
    setDraft: (id, text) => void drafts.push([id, text]),
    ...over
  }
  return { deps, starts, drafts }
}

describe('prompt drafting', () => {
  it('drafts the review prompt in English and Spanish with the PR facts', () => {
    const en = reviewPrompt('en', pr)
    expect(en).toContain('billing-api#133')
    expect(en).toContain(pr.url)
    expect(en).toContain(`${pr.branch} into main`)
    expect(en).toContain('Do not change anything or post any comment until I agree')
    const es = reviewPrompt('es', pr)
    expect(es).toContain('Revisa el pull request')
    expect(es).toContain(pr.url)
    expect(es).not.toContain('{')
  })
  it('drafts the ticket prompt with key, title and link, or without a link when there is none', () => {
    const withUrl = ticketPrompt('en', { key: 'DEMO-101', title: 'Retry webhooks', url: 'https://tracker.test/DEMO-101' })
    expect(withUrl).toContain('DEMO-101')
    expect(withUrl).toContain('"Retry webhooks"')
    expect(withUrl).toContain('https://tracker.test/DEMO-101')
    const none = ticketPrompt('es', { key: 'DEMO-101', title: 'Retry webhooks' })
    expect(none).toContain('DEMO-101')
    expect(none).not.toContain('Enlace')
    expect(none).not.toContain('{')
  })
  it('keeps the same placeholders in both languages', () => {
    for (const key of Object.keys(linksEn) as (keyof typeof linksEn)[]) {
      expect(placeholders(linksEs[key]), key).toEqual(placeholders(en[key]))
    }
  })
})

describe('Ask Claude to review', () => {
  it('starts Claude in app mode on the folder already on the PR branch and only drafts the prompt', async () => {
    const { deps, starts, drafts } = harness()
    const out = await runIntent(deps, { kind: 'reviewPullRequest', profileId: 'p', pr })
    expect(out).toEqual({ kind: 'started', sessionId: 'new-1', folder: '/w/billing-wt', drafted: true })
    expect(starts).toHaveLength(1)
    expect(starts[0]).toMatchObject({ agentKey: 'claude', cwd: '/w/billing-wt', mode: 'app' })
    // Nothing is sent: the start request carries no prompt and the draft only reaches the composer.
    expect(Object.keys(starts[0]!)).not.toContain('prompt')
    expect(drafts).toEqual([['new-1', reviewPrompt('en', pr)]])
  })
  it('never sends, even when a session for the PR is already open', async () => {
    const { deps, starts, drafts } = harness({ sessions: [live('s1', {}, { pullRequests: [pr.url] })] })
    await runIntent(deps, { kind: 'reviewPullRequest', profileId: 'p', pr })
    expect(starts).toHaveLength(1)
    expect(drafts).toHaveLength(1)
  })
  it('uses the profile first folder when no checkout matches, and the default folder with none', async () => {
    const other = { ...pr, owner: 'zed', repo: 'unknown' }
    const a = harness()
    expect(await runIntent(a.deps, { kind: 'reviewPullRequest', profileId: null, pr: other })).toMatchObject({ folder: '/w/storefront' })
    const b = harness({ checkouts: async () => [] })
    expect(await runIntent(b.deps, { kind: 'reviewPullRequest', profileId: null, pr })).toMatchObject({ folder: '/home/me' })
  })
  it('reports a missing Claude instead of drafting somewhere else', async () => {
    const { deps, starts, drafts } = harness({ agents: [agent('shell', false)] })
    expect(await runIntent(deps, { kind: 'reviewPullRequest', profileId: null, pr })).toEqual({ kind: 'error', message: 'links.noClaude', params: undefined })
    expect(starts).toHaveLength(0)
    expect(drafts).toHaveLength(0)
  })
})

describe('Open session', () => {
  it('opens the live session that touched the PR instead of starting another', async () => {
    const { deps, starts } = harness({ sessions: [live('stopped', { state: 'stopped' }, { pullRequests: [pr.url] }), live('s2', {}, { pullRequests: [pr.url.toUpperCase()] })] })
    expect(await runIntent(deps, { kind: 'pullRequestSession', profileId: 'p', pr })).toEqual({ kind: 'opened', sessionId: 's2' })
    expect(starts).toHaveLength(0)
  })
  it('links a live session by the ticket key in its label', async () => {
    const { deps } = harness({ sessions: [live('s3', { label: 'Work on DEMO-230' })] })
    expect(await runIntent(deps, { kind: 'pullRequestSession', profileId: 'p', pr })).toEqual({ kind: 'opened', sessionId: 's3' })
  })
  it('starts a plain session (no draft) in the matching folder when none is linked', async () => {
    const { deps, starts, drafts } = harness({ sessions: [live('unrelated', { label: 'Something else' })] })
    const out = await runIntent(deps, { kind: 'pullRequestSession', profileId: 'p', pr })
    expect(out).toEqual({ kind: 'started', sessionId: 'new-1', folder: '/w/billing-wt', drafted: false })
    expect(starts[0]!.cwd).toBe('/w/billing-wt')
    expect(drafts).toEqual([])
  })
})

describe('Start session about this ticket', () => {
  it('drafts key, title and link in a new app-mode session in the first folder, unsent', async () => {
    const { deps, starts, drafts } = harness()
    const ticket = { key: 'DEMO-101', title: 'Retry webhooks', url: 'https://tracker.test/DEMO-101' }
    expect(await runIntent(deps, { kind: 'ticketSession', profileId: 'p', ticket })).toMatchObject({ kind: 'started', drafted: true, folder: '/w/storefront' })
    expect(starts[0]).toMatchObject({ agentKey: 'claude', mode: 'app' })
    expect(drafts).toEqual([['new-1', ticketPrompt('en', ticket)]])
  })
  it('falls back to another app-mode agent without Claude, and reports none at all', async () => {
    expect(agentForDraft([agent('shell', false), agent('kiro')], false)?.key).toBe('kiro')
    expect(agentForDraft([agent('kiro')], true)).toBeUndefined()
    const { deps } = harness({ agents: [agent('shell', false)] })
    expect(await runIntent(deps, { kind: 'ticketSession', profileId: null, ticket: { key: 'A-1', title: 't' } })).toMatchObject({ kind: 'error', message: 'links.noAgent' })
  })
  it('turns a failing start into an error outcome', async () => {
    const { deps } = harness({ start: vi.fn().mockRejectedValue(new Error('boom')) })
    expect(await runIntent(deps, { kind: 'ticketSession', profileId: null, ticket: { key: 'A-1', title: 't' } })).toEqual({ kind: 'error', message: 'links.failed', params: { message: 'boom' } })
  })
})

describe('resuming a past session', () => {
  const entry = { agentId: 'claude', accountId: 'work', agentSessionId: 'abc', title: 't', lastModified: 1, agentName: 'Claude', resumable: true, cwd: '/w/billing' } as HistoryItem
  it('uses the History resume request: agent key from the account, the recorded folder and the session id', async () => {
    const { deps, starts } = harness()
    expect(await runIntent(deps, { kind: 'resume', profileId: 'p', entry, mode: 'app' })).toEqual({ kind: 'opened', sessionId: 'new-1' })
    expect(starts[0]).toMatchObject({ agentKey: 'claude:work', cwd: '/w/billing', resumeAgentSessionId: 'abc', mode: 'app' })
  })
  it('falls back to the default folder when the entry recorded none', async () => {
    const { deps, starts } = harness()
    await runIntent(deps, { kind: 'resume', profileId: null, entry: { ...entry, cwd: undefined }, mode: 'console' })
    expect(starts[0]).toMatchObject({ cwd: '/home/me', mode: 'console' })
  })
})

describe('parseWorktrees', () => {
  it('reads paths and branches, with detached heads and Windows paths', () => {
    const out = 'worktree /w/billing\nHEAD aaa\nbranch refs/heads/main\n\nworktree C:/w/billing-wt\nHEAD bbb\nbranch refs/heads/feat/x\n\nworktree /w/detached\nHEAD ccc\ndetached\n'
    expect(parseWorktrees(out)).toEqual([
      { path: '/w/billing', branch: 'main' },
      { path: 'C:/w/billing-wt', branch: 'feat/x' },
      { path: '/w/detached', branch: undefined }
    ])
    expect(parseWorktrees('')).toEqual([])
  })
})
