import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DemoChatSource,
  HOOK_SCRIPT_NAME,
  hookCommandIn,
  parseHookLine,
  parseOneshotOutput,
  SlackAgentChatSource,
  SlackTrackingHook,
  toReadResult,
  withHook,
  withoutHook
} from '../src/chat-slack'
import { locateClaudeTranscript } from '../src/transcript-claude'

const fixtures = join(import.meta.dirname, 'fixtures')
const hookScript = join(import.meta.dirname, '..', 'src', 'chat-slack', 'hook', 'slack-track-hook.mjs')
const NOW = Date.UTC(2026, 9, 27, 12)

describe('the agent-connector source', () => {
  it('reads the outcome line after any shell noise and maps failures', () => {
    const ok = parseOneshotOutput('noise\n{"ok":true,"result":"{\\"channels\\":[],\\"threads\\":[]}","rateLimited":false,"slackTools":["x_slack"],"deniedTools":["mcp__slack__slack_send_message"]}\n')
    expect(toReadResult(ok)).toMatchObject({ ok: true, deniedTools: ['mcp__slack__slack_send_message'] })
    expect(toReadResult(null)).toMatchObject({ ok: false, failure: 'failed' })
    expect(toReadResult({ ok: false, result: '', errorMessage: 'usage limit', rateLimited: true, resetsAt: new Date(NOW).toISOString(), slackTools: [], deniedTools: [] })).toMatchObject({ failure: 'rateLimited', resetsAt: NOW })
    expect(toReadResult({ ok: true, result: '{}', rateLimited: false, slackTools: [], deniedTools: [] })).toMatchObject({ failure: 'noConnector' })
    expect(toReadResult({ ok: true, result: 'prose', rateLimited: false, slackTools: ['s'], deniedTools: [] })).toMatchObject({ failure: 'invalidAnswer' })
  })

  it('runs the helper with the account folder and parses the digest', async () => {
    const source = new SlackAgentChatSource({ bridgeDir: join(fixtures, 'fake-oneshot'), nodeCommand: process.execPath, cwd: tmpdir(), timeoutSeconds: 20 })
    const r = await source.read({ channels: [{ id: 'C01', name: 'reviews', purpose: '' }], cursors: {}, threads: [], configDir: '/tmp/claude-work', model: 'haiku', now: NOW })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.digest.me).toBe('/tmp/claude-work')
      expect(r.digest.channels[0]?.messages[0]?.prUrls).toEqual(['https://github.com/acme/web/pull/9'])
    }
  })
})

describe('the demo source', () => {
  it('seeds each channel, serves injected messages after the cursor, replays duplicates and replies', async () => {
    const demo = new DemoChatSource(() => NOW)
    const channels = [{ id: 'C01', name: 'reviews', purpose: '' }]
    const first = await demo.read({ channels, cursors: {}, threads: [], model: 'haiku', now: NOW })
    expect(first.ok && first.digest.channels[0]?.messages.length).toBe(3)
    const cursor = first.ok ? first.digest.channels[0]!.messages.at(-1)!.ts : ''
    const m = demo.inject({ channelId: 'C01', user: 'Ana (demo)', text: 'https://github.com/acme-demo/web/pull/5' })
    const second = await demo.read({ channels, cursors: { C01: cursor }, threads: [], model: 'haiku', now: NOW })
    expect(second.ok && second.digest.channels[0]?.messages.map((x) => x.ts)).toEqual([m.ts])
    demo.inject({ channelId: 'C01', user: 'Ana (demo)', text: m.text, ts: m.ts, replay: true })
    const third = await demo.read({ channels, cursors: { C01: m.ts }, threads: [], model: 'haiku', now: NOW })
    expect(third.ok && third.digest.channels[0]?.messages.map((x) => x.ts)).toEqual([m.ts])
    demo.injectReply({ channelId: 'C01', threadTs: m.ts, user: 'Luis (demo)', text: 'approved' })
    const fourth = await demo.read({ channels, cursors: { C01: m.ts }, threads: [{ channelId: 'C01', ts: m.ts, lastSeenReplyTs: m.ts }], model: 'haiku', now: NOW })
    expect(fourth.ok && fourth.digest.threads[0]?.replies.map((r) => r.text)).toEqual(['approved'])
  })
})

describe('the tracking hook', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wh2-hook-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('adds and removes only its own entry, keeping Workhub 1\'s and every other key', () => {
    const w1 = { matcher: 'mcp__.*[Ss]lack.*send_message', hooks: [{ type: 'command', command: '"node" "/x/slack-track-hook.mjs"', timeout: 10 }] }
    const base = { model: 'opus', hooks: { PostToolUse: [w1], Stop: [{ hooks: [] }] } }
    const added = withHook(base, `"node" "/data/${HOOK_SCRIPT_NAME}"`)
    expect(added.changed).toBe(true)
    expect(hookCommandIn(added.settings)).toContain(HOOK_SCRIPT_NAME)
    expect(withHook(added.settings, `"node" "/data/${HOOK_SCRIPT_NAME}"`).changed).toBe(false)
    const removed = withoutHook(added.settings)
    expect(removed.settings).toEqual(base)
    expect(withoutHook({ hooks: { PostToolUse: [] } }).changed).toBe(false)
    expect(withoutHook(withHook({}, `x ${HOOK_SCRIPT_NAME}`).settings).settings).toEqual({})
  })

  it('installs into a settings.json in a temporary folder with a .bak copy, then removes it', async () => {
    const configDir = join(dir, 'claude')
    mkdirSync(configDir)
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ theme: 'dark' }))
    const hook = new SlackTrackingHook({ dir: join(dir, 'data'), sourceScript: hookScript, node: async () => '/usr/bin/node' })
    expect(await hook.status(configDir)).toEqual({ state: 'notInstalled' })
    await hook.install(configDir)
    expect(await hook.status(configDir)).toEqual({ state: 'installed' })
    const written = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8'))
    expect(written.theme).toBe('dark')
    expect(readFileSync(join(configDir, 'settings.json.bak'), 'utf8')).toBe(JSON.stringify({ theme: 'dark' }))
    await hook.remove(configDir)
    expect(JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8'))).toEqual({ theme: 'dark' })
    writeFileSync(join(configDir, 'settings.json'), '{oops')
    expect((await hook.status(configDir)).state).toBe('unreadable')
  })

  it('records a Slack message a session sent, and nothing for other tools', async () => {
    const data = join(dir, 'data')
    mkdirSync(data)
    copyFileSync(hookScript, join(data, HOOK_SCRIPT_NAME))
    const run = (payload: unknown) => execFileSync(process.execPath, [join(data, HOOK_SCRIPT_NAME)], { input: JSON.stringify(payload), env: { ...process.env, CLAUDE_CONFIG_DIR: '/tmp/claude-work' } })
    run({ tool_name: 'mcp__claude_ai_Slack__slack_read_channel', session_id: 'S0', tool_input: { channel_id: 'C0123456789' } })
    const out = run({
      tool_name: 'mcp__claude_ai_Slack__slack_send_message',
      session_id: 'AAAA-1',
      cwd: '/tmp/acme-web',
      tool_input: { channel_id: 'C0123456789', text: 'Please review https://github.com/acme/web/pull/3\nthanks' },
      tool_response: [{ type: 'text', text: JSON.stringify({ ok: true, ts: '1761566400.000100', permalink: 'https://acme.slack.com/archives/C0123456789/p1761566400000100' }) }]
    })
    expect(out.toString()).toBe('')
    const hook = new SlackTrackingHook({ dir: data, sourceScript: hookScript })
    const records = await hook.drain()
    expect(records).toEqual([
      expect.objectContaining({ sessionId: 'AAAA-1', channelId: 'C0123456789', ts: '1761566400.000100', threadTs: '1761566400.000100', cwd: '/tmp/acme-web', configDir: '/tmp/claude-work', title: 'Please review https://github.com/acme/web/pull/3' })
    ])
    expect(await hook.drain()).toEqual([])
    expect(parseHookLine('{"sessionId":"a"}')).toBeNull()
  })
})

describe('locating a Claude transcript', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wh2-transcript-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('takes the copy written last and reads its folder', async () => {
    const id = '11111111-2222-4333-8444-555555555555'
    for (const [account, cwd, age] of [['a', '/tmp/old-place', 60], ['b', '/tmp/acme-web', 0]] as const) {
      const folder = join(dir, account, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'))
      mkdirSync(folder, { recursive: true })
      const file = join(folder, `${id}.jsonl`)
      writeFileSync(file, `{"type":"summary"}\n{"type":"user","cwd":"${cwd}"}\n`)
      const t = new Date(Date.now() - age * 1000)
      utimesSync(file, t, t)
    }
    const found = await locateClaudeTranscript(id, [join(dir, 'a'), join(dir, 'b')])
    expect(found).toMatchObject({ cwd: '/tmp/acme-web', configDir: join(dir, 'b') })
    expect(await locateClaudeTranscript('../etc', [dir])).toBeNull()
  })
})
