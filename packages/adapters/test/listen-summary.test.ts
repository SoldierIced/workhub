import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { LISTEN_SYSTEM_PROMPT } from '@workhub/core'
import { runOneshot } from '../src/chat-slack/agent-source'
import { ListenSummarizer, toSummaryResult } from '../src/listen-summary'

const fixtures = join(import.meta.dirname, 'fixtures')
const answer = (o: Record<string, unknown>) => `login shell noise\n${JSON.stringify({ ok: true, result: '', rateLimited: false, slackTools: [], deniedTools: [], ...o })}\n`

function summarizer(out: string) {
  const run = vi.fn(async (_line: string, _ms: number, _signal?: AbortSignal) => out)
  return { s: new ListenSummarizer({ bridgeDir: '/nowhere', cwd: '/tmp/acme-data', timeoutSeconds: 30, run }), run }
}

describe('ListenSummarizer', () => {
  it('asks oneshot.mjs for one bare turn with the listen prompt, haiku by default, on the given account', async () => {
    const { s, run } = summarizer(answer({ result: 'The build passed.', costUsd: 0.0004 }))
    await s.summarize({ text: 'Long **message**', configDir: '/h/.claude-work' })
    const [line, killAfterMs] = run.mock.calls[0]!
    const request = JSON.parse(line)
    expect(request).toMatchObject({ cwd: '/tmp/acme-data', model: 'haiku', maxTurns: 1, timeoutSeconds: 30, bare: true, configDir: '/h/.claude-work', systemPrompt: LISTEN_SYSTEM_PROMPT })
    expect(request.prompt).toContain('Long **message**')
    expect(killAfterMs).toBe(40_000)
  })

  it('uses the configured model and leaves configDir out when there is none', async () => {
    const { s, run } = summarizer(answer({ result: 'ok' }))
    await s.summarize({ text: 'x', model: 'claude-sonnet-4-5' })
    const request = JSON.parse(run.mock.calls[0]![0])
    expect(request.model).toBe('claude-sonnet-4-5')
    expect(request).not.toHaveProperty('configDir')
  })

  it('answers the summary cleaned for speech, with its cost', async () => {
    const { s } = summarizer(answer({ result: '## Summary\n**Tests pass** now, see https://example.com/run/1.', costUsd: 0.0004 }))
    expect(await s.summarize({ text: 'x' })).toEqual({ ok: true, summary: 'Summary.\nTests pass now, see.', costUsd: 0.0004 })
  })

  it('reports a timeout, a rate limit, a missing login and an empty answer', async () => {
    expect(await summarizer(answer({ ok: false, errorMessage: 'Timed out after 30 s' })).s.summarize({ text: 'x' })).toMatchObject({ ok: false, failure: 'timeout' })
    expect(await summarizer(answer({ ok: false, errorMessage: 'usage limit reached', rateLimited: true })).s.summarize({ text: 'x' })).toMatchObject({ ok: false, failure: 'rateLimited' })
    expect(await summarizer(answer({ ok: false, errorMessage: 'Not logged in · Please run /login' })).s.summarize({ text: 'x' })).toMatchObject({ ok: false, failure: 'noAccount' })
    expect(await summarizer(answer({ result: '```\ncode only\n```' })).s.summarize({ text: 'x' })).toMatchObject({ ok: false, failure: 'failed', error: 'The summary was empty.' })
    expect(await summarizer('crashed before answering').s.summarize({ text: 'x' })).toMatchObject({ ok: false, failure: 'failed' })
  })

  it('answers cancelled when its signal aborted, whatever the helper printed', () => {
    expect(toSummaryResult(null, true)).toEqual({ ok: false, failure: 'cancelled', error: 'Cancelled.' })
  })

  it('kills a helper that hangs when the signal aborts', async () => {
    const controller = new AbortController()
    const s = new ListenSummarizer({ bridgeDir: join(fixtures, 'fake-oneshot'), script: 'listen-slow.mjs', nodeCommand: process.execPath, cwd: '/tmp', timeoutSeconds: 60 })
    const pending = s.summarize({ text: 'x', signal: controller.signal })
    setTimeout(() => controller.abort(), 200)
    expect(await pending).toMatchObject({ ok: false, failure: 'cancelled' })
  })

  it('runOneshot kills a helper past its deadline and resolves with what it printed', async () => {
    const started = Date.now()
    expect(await runOneshot({ bridgeDir: join(fixtures, 'fake-oneshot'), script: 'listen-slow.mjs', nodeCommand: process.execPath }, '{}', 300)).toBe('')
    expect(Date.now() - started).toBeLessThan(5000)
  })
})

describe('oneshot.mjs bare mode', () => {
  it('loads no settings, plugins or connectors when the request is bare', () => {
    const source = readFileSync(join(import.meta.dirname, '../src/agent-claude-native/bridge/oneshot.mjs'), 'utf8')
    const block = source.slice(source.indexOf('if (request.bare) {'), source.indexOf('} else if (slackPlugin)'))
    expect(block).toContain('options.settingSources = [];')
    expect(block).toContain('ENABLE_CLAUDEAI_MCP_SERVERS = "false"')
    expect(source).toContain('const slackPlugin = request.bare ? undefined')
    // No built-in tools in any mode.
    expect(source).toContain('tools: [],')
  })
})
