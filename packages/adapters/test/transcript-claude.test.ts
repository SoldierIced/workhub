import { appendFile, cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { describeTool, estimateCost, isJiraWrite, pullRequestUrls, ticketKeys } from '../src/shared/claude-tools'
import { ClaudeTranscriptParser } from '../src/transcript-claude/parser'
import { ClaudeTranscriptReader, subagentStatus } from '../src/transcript-claude'

// A synthetic transcript (test/fixtures/claude-config): one session in /tmp/acme-web with a
// tool call per kind, a PR opened by a command, one Explore subagent and a sidechain entry.
const config = join(import.meta.dirname, 'fixtures', 'claude-config')
const SESSION = '11111111-2222-4333-8444-555555555555'
const query = { agentSessionId: SESSION, cwd: '/tmp/acme-web', configDir: config }
const at = Date.parse('2026-10-01T12:00:10.000Z')

describe('ClaudeTranscriptReader', () => {
  it('fills the monitor: title, model, tokens, cost, context and active time', async () => {
    const snap = await new ClaudeTranscriptReader({ now: () => at }).read(query)
    expect(snap?.title).toBe('Login form fix')
    expect(snap?.model).toBe('claude-sonnet-5')
    // Main conversation (one entry per message id, the sidechain left out) plus the subagent.
    expect(snap?.tokens).toEqual({ input: 325, output: 205, cacheRead: 8100, cacheWrite: 500, total: 9130 })
    expect(snap?.cost?.amount).toBeCloseTo(0.00587, 8)
    expect(snap?.context).toEqual({ used: 2605, size: 200_000, percent: (2605 / 200_000) * 100 })
    // Two turns: 30 s and 4 s; the local /model command is not a turn.
    expect(snap?.activeTimeMs).toBe(34_000)
  })

  it('describes tool calls in words and tracks their result', async () => {
    const snap = await new ClaudeTranscriptReader({ now: () => at }).read(query)
    expect(snap?.toolCalls?.map((t) => [t.title, t.kind, t.status])).toEqual([
      ['Read login.ts', 'read', 'completed'],
      ['Open the pull request', 'execute', 'completed'],
      ['Started a Explore subagent', 'other', 'completed']
    ])
    expect(snap?.toolCalls?.[1]?.detail).toMatch(/^\$ gh pr create/)
  })

  it('detects the PR from the command output and the ticket from the branch, prompt and command', async () => {
    const snap = await new ClaudeTranscriptReader({ now: () => at }).read(query)
    expect(snap?.pullRequests).toEqual(['https://github.com/acme/web/pull/42'])
    expect(snap?.ticketKeys).toEqual(['ABC-12'])
  })

  it('reads subagents with their own model, tokens, cost and status', async () => {
    const snap = await new ClaudeTranscriptReader({ now: () => at }).read(query)
    expect(snap?.subagents).toHaveLength(1)
    expect(snap?.subagents?.[0]).toMatchObject({
      id: 'a1',
      type: 'Explore',
      description: 'Find other forms',
      model: 'claude-haiku-5',
      status: 'completed',
      stepCount: 1,
      lastStep: 'Searched the code for "<form"',
      tokens: { input: 300, output: 30, total: 330 }
    })
    expect(snap?.subagents?.[0]?.cost?.amount).toBeCloseTo(0.00045, 8)
  })

  it('returns null for a session without a transcript and rejects ids that are not file names', async () => {
    const reader = new ClaudeTranscriptReader()
    expect(await reader.read({ ...query, agentSessionId: 'aaaaaaaa-0000-4000-8000-000000000000' })).toBeNull()
    expect(await reader.exists({ ...query, agentSessionId: '../escape' })).toBe(false)
    expect(await reader.exists(query)).toBe(true)
    // Found by scanning the projects folder when the cwd does not match its folder name.
    expect(await reader.exists({ ...query, cwd: '/elsewhere' })).toBe(true)
  })

  describe('incremental reads', () => {
    let dir = ''
    afterEach(async () => {
      if (dir) await rm(dir, { recursive: true, force: true })
    })

    it('reads only what was appended, including a line split across reads', async () => {
      dir = await mkdtemp(join(tmpdir(), 'wh-transcript-'))
      await cp(config, dir, { recursive: true })
      const file = join(dir, 'projects', '-tmp-acme-web', `${SESSION}.jsonl`)
      const reader = new ClaudeTranscriptReader({ now: () => at })
      const q = { ...query, configDir: dir }
      expect((await reader.read(q))?.toolCalls).toHaveLength(3)
      const line = JSON.stringify({
        type: 'assistant',
        timestamp: '2026-10-01T12:00:08.000Z',
        message: { id: 'msg_5', model: 'claude-sonnet-5', usage: { input_tokens: 1 }, content: [{ type: 'tool_use', id: 'toolu_w', name: 'Write', input: { file_path: '/tmp/acme-web/notes.md' } }] }
      })
      await appendFile(file, line.slice(0, 40))
      expect((await reader.read(q))?.toolCalls).toHaveLength(3)
      await appendFile(file, `${line.slice(40)}\n`)
      const snap = await reader.read(q)
      expect(snap?.toolCalls?.at(-1)).toMatchObject({ title: 'Wrote notes.md', status: 'in_progress' })
      expect(snap?.tokens?.input).toBe(326)
    })
  })
})

describe('Claude tool helpers', () => {
  it('describes MCP tools by server and action', () => {
    expect(describeTool('mcp__acme_tracker__get_issue', {}).title).toBe('Called acme_tracker: get issue')
  })

  it('finds GitHub and GitLab pull requests once each', () => {
    const text = 'see https://github.com/Acme/Web/pull/42/files and https://github.com/acme/web/pull/42 and https://gitlab.example.com/acme/api/-/merge_requests/7'
    expect(pullRequestUrls(text)).toEqual(['https://github.com/acme/web/pull/42', 'https://gitlab.example.com/acme/api/-/merge_requests/7'])
  })

  it('finds ticket keys, limited to the configured projects when there are any', () => {
    expect(ticketKeys('ABC-1 then UTF-8 and def-2')).toEqual(['ABC-1'])
    expect(ticketKeys('ABC-1 then def-2 and XYZ-3', ['def', 'ABC'])).toEqual(['ABC-1', 'DEF-2'])
  })

  it('finds ticket keys between underscores, as branch names write them', () => {
    expect(ticketKeys('hotfix_TEAM-8571_same-holder', ['TEAM'])).toEqual(['TEAM-8571'])
    expect(ticketKeys('feat/pay-3619-savings and XPAY-1', ['PAY'])).toEqual(['PAY-3619'])
  })

  it('tells the Jira tools that create or change a ticket from the ones that read', () => {
    expect(isJiraWrite('mcp__atlassian__createJiraIssue')).toBe('create')
    expect(isJiraWrite('mcp__atlassian__createIssueLink')).toBe('change')
    expect(isJiraWrite('mcp__atlassian__transitionJiraIssue')).toBe('change')
    expect(isJiraWrite('mcp__atlassian__addCommentToJiraIssue')).toBe('change')
    expect(isJiraWrite('mcp__atlassian__getJiraIssue')).toBeNull()
    expect(isJiraWrite('Bash')).toBeNull()
  })

  it('reports the tickets the session created or changed, the created one first, apart from the ones it named', () => {
    const parser = new ClaudeTranscriptParser({ ticketPrefixes: ['PAY', 'TEAM'] })
    let n = 0
    const call = (name: string, input: Record<string, unknown>, result: string) => {
      const id = `t${++n}`
      parser.ingest(JSON.stringify({ type: 'assistant', message: { id: `m${n}`, content: [{ type: 'tool_use', id, name: `mcp__atlassian__${name}`, input }] } }))
      parser.ingest(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: result }] } }))
    }
    parser.ingest(JSON.stringify({ type: 'user', message: { content: 'Fraud asked for TEAM-8571, see also PAY-1648' } }))
    call('getJiraIssue', { issueIdOrKey: 'TEAM-8571' }, 'TEAM-8571: block same-holder Pix')
    call('createJiraIssue', { projectKey: 'PAY', summary: 'Block same-holder Pix (TEAM-8571)', parent: 'PAY-2029' }, '{"key":"PAY-3806","parent":"PAY-2029"}')
    call('createIssueLink', { inwardIssue: 'PAY-3806', outwardIssue: 'TEAM-8571' }, 'linked')
    call('addCommentToJiraIssue', { issueIdOrKey: 'TEAM-8571', commentBody: 'Tracked in PAY-3806' }, 'ok')
    const snap = parser.snapshot()
    expect(snap.linkedTicketKeys).toEqual(['PAY-3806', 'TEAM-8571'])
    // The named ones stay in order of last mention.
    expect(snap.ticketKeys).toContain('PAY-1648')
  })

  it('prices known models only', () => {
    expect(estimateCost('claude-haiku-5', { input: 1_000_000 })?.amount).toBe(1)
    expect(estimateCost('some-other-model', { input: 1 })).toBeUndefined()
  })

  it('infers subagent status from the answer, the parent call and silence', () => {
    expect(subagentStatus(true, 0, { done: true, failed: true })).toBe('failed')
    expect(subagentStatus(false, 5_000, { done: false, failed: false })).toBe('running')
    expect(subagentStatus(false, 700_000, { done: false, failed: false })).toBe('stopped')
    expect(subagentStatus(false, 60_000, { done: true, failed: false })).toBe('background')
    expect(subagentStatus(false, 60_000, undefined)).toBe('stopped')
  })
})
