import { appendFile, cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claudeHandoffFacts, claudeSessionPaths, copyAction, copyClaudeSession, readClaudeHandoffFacts, SessionCopyError } from '../src/transcript-claude'

// The synthetic account of transcript-claude.test.ts: one session in /tmp/acme-web with a subagent.
const fixture = join(import.meta.dirname, 'fixtures', 'claude-config')
const SESSION = '11111111-2222-4333-8444-555555555555'
const FOLDER = '-tmp-acme-web'
const transcript = join('projects', FOLDER, `${SESSION}.jsonl`)

const exists = (path: string) => stat(path).then(() => true, () => false)

describe('copyAction', () => {
  const b = (s: string) => Buffer.from(s)
  it('copies a missing file, leaves an identical one, extends a prefix and refuses anything else', () => {
    expect(copyAction(b('abc'), null)).toBe('copy')
    expect(copyAction(b('abc'), b('abc'))).toBe('unchanged')
    expect(copyAction(b('abc\ndef'), b('abc'))).toBe('extend')
    expect(copyAction(b('abc'), b('abd'))).toBe('conflict')
    expect(copyAction(b('abc'), b('abcd'))).toBe('conflict')
  })

  it('names the per-session paths Claude Code keeps', () => {
    expect(claudeSessionPaths('s1', 'f')).toEqual({ transcript: join('projects', 'f', 's1.jsonl'), dirs: [join('projects', 'f', 's1'), join('file-history', 's1'), join('tasks', 's1')], todoPrefix: 's1-agent-' })
  })
})

describe('copyClaudeSession', () => {
  let root: string
  let source: string
  let target: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wh-copy-'))
    source = join(root, 'personal')
    target = join(root, 'laboral')
    await cp(fixture, source, { recursive: true })
    await mkdir(join(source, 'file-history', SESSION), { recursive: true })
    await writeFile(join(source, 'file-history', SESSION, 'abc@v1'), 'old contents')
    await mkdir(join(source, 'tasks', SESSION), { recursive: true })
    await writeFile(join(source, 'tasks', SESSION, '1.json'), '{"id":"1"}')
    await mkdir(join(source, 'todos'), { recursive: true })
    await writeFile(join(source, 'todos', `${SESSION}-agent-${SESSION}.json`), '[]')
    await writeFile(join(source, 'todos', 'other-agent-other.json'), '[]')
    await mkdir(join(source, 'projects', '-elsewhere'), { recursive: true })
    await writeFile(join(source, 'projects', '-elsewhere', 'unrelated.jsonl'), '{}')
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const input = () => ({ sessionId: SESSION, cwd: '/tmp/acme-web', sourceConfigDir: source, targetConfigDir: target })

  it('copies the transcript and every sidecar under the same folder name, and nothing else', async () => {
    const r = await copyClaudeSession(input())
    expect(r.folder).toBe(FOLDER)
    expect(r.copied.sort()).toEqual(
      [
        transcript,
        join('projects', FOLDER, SESSION, 'subagents', 'agent-a1.jsonl'),
        join('projects', FOLDER, SESSION, 'subagents', 'agent-a1.meta.json'),
        join('file-history', SESSION, 'abc@v1'),
        join('tasks', SESSION, '1.json'),
        join('todos', `${SESSION}-agent-${SESSION}.json`)
      ].sort()
    )
    expect(await readFile(join(target, transcript), 'utf8')).toBe(await readFile(join(source, transcript), 'utf8'))
    expect(await exists(join(target, 'projects', '-elsewhere'))).toBe(false)
    expect(await exists(join(target, 'todos', 'other-agent-other.json'))).toBe(false)
    // The source is untouched.
    expect(await exists(join(source, transcript))).toBe(true)
  })

  it('finds the session in another project folder when the cwd moved', async () => {
    expect((await copyClaudeSession({ ...input(), cwd: '/somewhere/else' })).folder).toBe(FOLDER)
  })

  it('leaves identical files alone and only appends what an older copy is missing', async () => {
    await copyClaudeSession(input())
    const again = await copyClaudeSession(input())
    expect(again.copied).toEqual([])
    expect(again.unchanged).toContain(transcript)
    const extra = '{"type":"user","message":{"role":"user","content":"more"}}\n'
    await appendFile(join(source, transcript), extra)
    const before = await readFile(join(target, transcript), 'utf8')
    const third = await copyClaudeSession(input())
    expect(third.extended).toEqual([transcript])
    expect(await readFile(join(target, transcript), 'utf8')).toBe(before + extra)
  })

  it('refuses a diverging transcript in the other account and writes nothing', async () => {
    await mkdir(join(target, 'projects', FOLDER), { recursive: true })
    await writeFile(join(target, transcript), '{"different":true}\n')
    await expect(copyClaudeSession(input())).rejects.toMatchObject({ code: 'conflict' })
    expect(await readFile(join(target, transcript), 'utf8')).toBe('{"different":true}\n')
    expect(await exists(join(target, 'file-history'))).toBe(false)
  })

  it('skips and reports a diverging sidecar but copies the rest', async () => {
    await mkdir(join(target, 'file-history', SESSION), { recursive: true })
    await writeFile(join(target, 'file-history', SESSION, 'abc@v1'), 'someone else')
    const r = await copyClaudeSession(input())
    expect(r.conflicts).toEqual([join('file-history', SESSION, 'abc@v1')])
    expect(await readFile(join(target, 'file-history', SESSION, 'abc@v1'), 'utf8')).toBe('someone else')
    expect(r.copied).toContain(transcript)
  })

  it('never follows a symbolic link out of the session folders', async () => {
    const secret = join(root, 'secret.txt')
    await writeFile(secret, 'do not copy')
    await symlink(secret, join(source, 'tasks', SESSION, 'link.json'))
    const r = await copyClaudeSession(input())
    expect(r.copied).not.toContain(join('tasks', SESSION, 'link.json'))
    expect(await exists(join(target, 'tasks', SESSION, 'link.json'))).toBe(false)
  })

  it('fails clearly for the same folder, a missing session or an odd id', async () => {
    await expect(copyClaudeSession({ ...input(), targetConfigDir: source })).rejects.toMatchObject({ code: 'same-folder' })
    await expect(copyClaudeSession({ ...input(), sessionId: 'aaaaaaaa-0000-4000-8000-000000000000' })).rejects.toMatchObject({ code: 'not-found' })
    await expect(copyClaudeSession({ ...input(), sessionId: '../x' })).rejects.toBeInstanceOf(SessionCopyError)
  })
})

const line = (o: object) => JSON.stringify(o)

describe('claudeHandoffFacts', () => {
  it('reads the fixture: goal, the PR the command opened, the ticket and the commands', async () => {
    const facts = await readClaudeHandoffFacts({ sessionId: SESSION, cwd: '/tmp/acme-web', configDir: fixture, ticketPrefixes: ['ABC'] })
    expect(facts?.goal).toBe('Fix the login form for ABC-12, then open the PR.')
    expect(facts?.pullRequests).toEqual(['https://github.com/acme/web/pull/42'])
    expect(facts?.tickets).toContain('ABC-12')
    expect(facts?.commands[0]).toMatch(/^gh pr create/)
    expect(facts?.exchanges[0]).toEqual({ role: 'user', text: 'Fix the login form for ABC-12, then open the PR.' })
    expect(facts?.exchanges.some((m) => m.role === 'agent' && m.text.startsWith('Reading the form first.'))).toBe(true)
    expect(await readClaudeHandoffFacts({ sessionId: 'aaaaaaaa-0000-4000-8000-000000000000', cwd: '/x', configDir: fixture })).toBeNull()
  })

  it('collects edited files, the latest task list, and skips meta, sidechain and command wrappers', () => {
    const facts = claudeHandoffFacts([
      line({ type: 'user', isMeta: true, message: { role: 'user', content: 'Caveat: injected' } }),
      line({ type: 'user', message: { role: 'user', content: '<command-name>/model</command-name>' } }),
      line({ type: 'user', message: { role: 'user', content: 'Add retries' } }),
      line({
        type: 'assistant',
        message: {
          id: 'm1',
          content: [
            { type: 'text', text: 'On it.' },
            { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/w/a.ts' } },
            { type: 'tool_use', id: 't2', name: 'Write', input: { file_path: '/w/b.ts' } },
            { type: 'tool_use', id: 't3', name: 'Edit', input: { file_path: '/w/a.ts' } },
            { type: 'tool_use', id: 't4', name: 'TodoWrite', input: { todos: [{ content: 'old', status: 'pending', activeForm: 'x' }] } },
            { type: 'tool_use', id: 't5', name: 'TodoWrite', input: { todos: [{ content: 'Write retries', status: 'completed' }, { content: 'Test timeouts', status: 'in_progress' }] } }
          ]
        }
      }),
      line({ type: 'assistant', isSidechain: true, message: { id: 'm2', content: [{ type: 'tool_use', id: 's1', name: 'Edit', input: { file_path: '/w/sub.ts' } }] } }),
      line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }),
      'not json'
    ])
    expect(facts.goal).toBe('Add retries')
    expect(facts.filesTouched).toEqual(['/w/a.ts', '/w/b.ts'])
    expect(facts.todos).toEqual([
      { text: 'Write retries', status: 'completed' },
      { text: 'Test timeouts', status: 'in_progress' }
    ])
    expect(facts.exchanges).toEqual([
      { role: 'user', text: 'Add retries' },
      { role: 'agent', text: 'On it.' }
    ])
  })

  it('follows the newer TaskCreate / TaskUpdate task list', () => {
    const facts = claudeHandoffFacts([
      line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'c1', name: 'TaskCreate', input: { subject: 'Write retries', description: 'd' } }, { type: 'tool_use', id: 'c2', name: 'TaskCreate', input: { subject: 'Test timeouts', description: 'd' } }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'Task #1 created successfully' }, { type: 'tool_result', tool_use_id: 'c2', content: 'Task #2 created successfully' }] } }),
      line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'u1', name: 'TaskUpdate', input: { taskId: '1', status: 'completed' } }, { type: 'tool_use', id: 'u2', name: 'TaskUpdate', input: { taskId: '2', status: 'in_progress' } }] } })
    ])
    expect(facts.todos).toEqual([
      { text: 'Write retries', status: 'completed' },
      { text: 'Test timeouts', status: 'in_progress' }
    ])
  })
})
