import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ClaudeTranscriptParser, SubagentParser } from '../src/transcript-claude/parser'
import { ClaudeTranscriptReader } from '../src/transcript-claude/reader'

const HOME = '/Users/ana'
const BASE = '/Users/ana/wayni'
const at = (s: number) => new Date(Date.UTC(2026, 9, 27, 12, 0, s)).toISOString()
const line = (cwd: string, s: number, content: object[], type: 'assistant' | 'user' = 'assistant') =>
  JSON.stringify({ type, cwd, timestamp: at(s), message: type === 'assistant' ? { id: `m${s}`, content } : { content } })
const tool = (name: string, input: object) => ({ type: 'tool_use', id: `t-${name}-${JSON.stringify(input).length}`, name, input })

/** A session started in a folder of repositories that read docs, edited api and moved into web. */
const SESSION = [
  JSON.stringify({ type: 'user', cwd: BASE, timestamp: at(0), message: { content: 'fix the login' } }),
  line(BASE, 1, [tool('Read', { file_path: `${BASE}/docs/README.md` })]),
  line(BASE, 2, [tool('Edit', { file_path: `${BASE}/api/src/login.ts`, old_string: 'a', new_string: 'b' })]),
  line(BASE, 3, [tool('Bash', { command: 'cd web && npm test' })]),
  // Claude Code follows the shell: later entries carry the new cwd.
  line(`${BASE}/web`, 4, [tool('Bash', { command: 'git status' })])
]

describe('the folders a Claude session worked in', () => {
  it('lists its cwd as it moved and what its edits and cds touched, not what it read', () => {
    const p = new ClaudeTranscriptParser({ home: HOME })
    for (const l of SESSION) p.ingest(l)
    // The Bash call ran in the base folder (noted again) before its cd into web.
    expect(p.snapshot().workPaths).toEqual([`${BASE}/api/src`, BASE, `${BASE}/web`])
  })

  it('leaves the field unset before anything was read', () => {
    expect(new ClaudeTranscriptParser({ home: HOME }).snapshot().workPaths).toBeUndefined()
  })

  it("adds a subagent's own edits and cds", () => {
    const sub = new SubagentParser(Date.now, HOME)
    sub.ingest(line(BASE, 1, [tool('Write', { file_path: `${BASE}/payments/x.ts`, content: '' })]))
    sub.ingest(line(BASE, 2, [tool('Bash', { command: 'git -C ~/wayni/cash-out diff' })]))
    expect(sub.workPaths).toEqual([`${BASE}/payments`, `${BASE}/cash-out`])
  })
})

describe('the transcript reader', () => {
  const dir = mkdtempSync(join(tmpdir(), 'workhub-claude-work-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it("merges the subagents' folders into the session's", async () => {
    const id = '0a1b2c3d-0000-4000-8000-000000000001'
    const folder = join(dir, 'projects', BASE.replace(/[^A-Za-z0-9]/g, '-'))
    mkdirSync(join(folder, id, 'subagents'), { recursive: true })
    writeFileSync(join(folder, `${id}.jsonl`), `${SESSION.join('\n')}\n`)
    writeFileSync(join(folder, id, 'subagents', 'agent-a1.jsonl'), `${line(BASE, 5, [tool('Edit', { file_path: `${BASE}/payments/src/pay.ts` })])}\n`)
    const reader = new ClaudeTranscriptReader({ defaultConfigDir: dir })
    const snap = await reader.read({ agentSessionId: id, cwd: BASE })
    expect(snap?.workPaths?.slice(-2)).toEqual([`${BASE}/web`, `${BASE}/payments/src`])
    expect(snap?.workPaths).toContain(`${BASE}/api/src`)
  })
})
