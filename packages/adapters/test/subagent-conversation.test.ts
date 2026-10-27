import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { acpToolResult, acpToolView } from '../src/agent-acp/tool-view'
import { ClaudeBridgeMapper } from '../src/agent-claude-native/mapping'
import { argSummary, claudeToolResult, claudeToolView, RESULT_TEXT_LIMIT } from '../src/shared/claude-tool-view'
import { CONVERSATION_LIMIT, SubagentConversationBuilder } from '../src/transcript-claude/conversation'
import { ClaudeTranscriptReader } from '../src/transcript-claude'

const T0 = Date.parse('2026-10-01T10:00:00.000Z')
const ts = (s: number) => new Date(T0 + s * 1000).toISOString()

const user = (s: number, content: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'user', isSidechain: true, cwd: '/tmp/acme', timestamp: ts(s), message: { role: 'user', content }, ...extra })
const assistant = (s: number, id: string, content: unknown[], stop: string | null = null) =>
  JSON.stringify({
    type: 'assistant',
    isSidechain: true,
    timestamp: ts(s),
    message: { id, model: 'claude-sonnet-5', stop_reason: stop, usage: { input_tokens: 10, output_tokens: 5 }, content }
  })

/** A synthetic sidechain: prompt, thinking, an edit with its patch, a failed command, a nested Task, the answer. */
const SIDECHAIN = [
  user(0, 'Fix the login form validation.\n\nUse `zod`.'),
  assistant(4, 'm1', [{ type: 'thinking', thinking: 'The schema lives in src/login.ts.', signature: 'x' }]),
  assistant(5, 'm1', [{ type: 'text', text: 'I will update the schema.' }]),
  assistant(6, 'm1', [{ type: 'tool_use', id: 'tu_edit', name: 'Edit', input: { file_path: '/tmp/acme/src/login.ts', old_string: 'min(1)', new_string: 'min(8)' } }], 'tool_use'),
  user(7, [{ type: 'tool_result', tool_use_id: 'tu_edit', content: 'The file was updated.' }], {
    toolUseResult: { filePath: '/tmp/acme/src/login.ts', structuredPatch: [{ oldStart: 12, oldLines: 1, newStart: 12, newLines: 1, lines: ['-  password: z.string().min(1),', '+  password: z.string().min(8),'] }] }
  }),
  assistant(8, 'm2', [{ type: 'tool_use', id: 'tu_bash', name: 'Bash', input: { command: 'npm test', description: 'Run the tests' } }], 'tool_use'),
  user(20, [{ type: 'tool_result', tool_use_id: 'tu_bash', content: 'Exit code 1\n1 failing', is_error: true }], { toolUseResult: { stdout: '1 failing', stderr: '', interrupted: false } }),
  assistant(21, 'm3', [{ type: 'tool_use', id: 'tu_task', name: 'Task', input: { subagent_type: 'Explore', description: 'Find forms', prompt: 'Find other forms' } }], 'tool_use'),
  user(30, [{ type: 'tool_result', tool_use_id: 'tu_task', content: [{ type: 'text', text: 'Two forms.' }] }]),
  assistant(31, 'm4', [{ type: 'text', text: 'Done: the password needs **8** characters.' }], 'end_turn')
]

describe('claudeToolView', () => {
  it('describes edits, writes and notebook cells with their text', () => {
    expect(claudeToolView('Edit', { file_path: '/r/a.ts', old_string: 'a', new_string: 'b', replace_all: true })).toEqual({
      kind: 'edit',
      path: '/r/a.ts',
      edits: [{ oldText: 'a', newText: 'b', replaceAll: true }]
    })
    expect(claudeToolView('MultiEdit', { file_path: '/r/a.ts', edits: [{ old_string: '1', new_string: '2' }, null, { old_string: '3', new_string: '4' }] })).toEqual({
      kind: 'edit',
      path: '/r/a.ts',
      edits: [
        { oldText: '1', newText: '2' },
        { oldText: '3', newText: '4' }
      ]
    })
    expect(claudeToolView('Write', { file_path: '/r/new.ts', content: 'export {}\n' })).toEqual({ kind: 'write', path: '/r/new.ts', content: 'export {}\n' })
    expect(claudeToolView('NotebookEdit', { notebook_path: '/r/n.ipynb', new_source: 'print(1)' })).toEqual({ kind: 'write', path: '/r/n.ipynb', content: 'print(1)' })
  })

  it('describes reads, searches, commands, the web, tasks and todos', () => {
    expect(claudeToolView('Read', { file_path: '/r/a.ts', offset: 10, limit: 50 })).toEqual({ kind: 'read', path: '/r/a.ts', offset: 10, limit: 50 })
    expect(claudeToolView('Grep', { pattern: 'TODO', path: 'src', glob: '*.ts' })).toEqual({ kind: 'search', tool: 'Grep', pattern: 'TODO', path: 'src', glob: '*.ts' })
    expect(claudeToolView('Glob', { pattern: '**/*.md' })).toEqual({ kind: 'search', tool: 'Glob', pattern: '**/*.md' })
    expect(claudeToolView('Bash', { command: 'ls', description: 'List' })).toEqual({ kind: 'command', command: 'ls', description: 'List' })
    expect(claudeToolView('WebFetch', { url: 'https://x.dev', prompt: 'Summarize' })).toEqual({ kind: 'fetch', url: 'https://x.dev', prompt: 'Summarize' })
    expect(claudeToolView('WebSearch', { query: 'zod min' })).toEqual({ kind: 'webSearch', query: 'zod min' })
    expect(claudeToolView('Agent', { subagent_type: 'Explore', description: 'Look', prompt: 'Go' })).toEqual({ kind: 'task', subagentType: 'Explore', description: 'Look', prompt: 'Go' })
    expect(
      claudeToolView('TodoWrite', {
        todos: [
          { content: 'Write the test', status: 'completed' },
          { content: 'Fix it', status: 'in_progress' },
          { content: 'Ship', status: 'weird' },
          { status: 'pending' }
        ]
      })
    ).toEqual({
      kind: 'todo',
      items: [
        { text: 'Write the test', status: 'completed' },
        { text: 'Fix it', status: 'in_progress' },
        { text: 'Ship', status: 'pending' }
      ]
    })
  })

  it('names the MCP server and tool and summarizes other tools by their arguments', () => {
    expect(claudeToolView('mcp__github__create_issue', { title: 'Bug', body: 'Line one\nline two', labels: ['a'] })).toEqual({
      kind: 'mcp',
      server: 'github',
      tool: 'create_issue',
      args: [
        { key: 'title', value: 'Bug' },
        { key: 'body', value: 'Line one line two' },
        { key: 'labels', value: '["a"]' }
      ]
    })
    expect(claudeToolView('Skill', { skill: 'review' })).toEqual({ kind: 'generic', tool: 'Skill', args: [{ key: 'skill', value: 'review' }] })
    expect(argSummary({ long: 'x'.repeat(500) })[0]!.value).toHaveLength(160)
  })
})

describe('claudeToolResult', () => {
  it('reads exit codes, match counts, line counts, patches and the started agent', () => {
    expect(claudeToolResult('Bash', 'ok', false)).toMatchObject({ text: 'ok', exitCode: 0 })
    expect(claudeToolResult('Bash', 'Exit code 2\nboom', true)).toMatchObject({ isError: true, exitCode: 2 })
    expect(claudeToolResult('Bash', 'Command interrupted', false, { interrupted: true }).exitCode).toBeUndefined()
    expect(claudeToolResult('Grep', 'a.ts\nb.ts', false, { numFiles: 2 }).matchCount).toBe(2)
    expect(claudeToolResult('Grep', 'Found 3 files\na\nb\nc', false).matchCount).toBe(3)
    expect(claudeToolResult('Glob', 'No files found', false).matchCount).toBe(0)
    expect(claudeToolResult('Read', '1→x', false, { file: { numLines: 40 } }).lineCount).toBe(40)
    expect(claudeToolResult('Edit', 'ok', false, { structuredPatch: [{ oldStart: 3, newStart: 3, lines: ['-a', '+b'] }] }).patch).toEqual([{ oldStart: 3, newStart: 3, lines: ['-a', '+b'] }])
    expect(claudeToolResult('Task', [{ type: 'text', text: 'done' }], false, { agentId: 'a9' })).toMatchObject({ text: 'done', agentId: 'a9' })
  })

  it('cuts long output and says so', () => {
    const r = claudeToolResult('Bash', 'x'.repeat(RESULT_TEXT_LIMIT + 10), false)
    expect(r.text).toHaveLength(RESULT_TEXT_LIMIT)
    expect(r.truncated).toBe(true)
  })
})

describe('SubagentConversationBuilder', () => {
  const build = (lines: string[]) => {
    const b = new SubagentConversationBuilder()
    for (const l of lines) b.ingest(l)
    return b.snapshot()
  }

  it('shows the prompt, thinking with its time, text, tools with results and the final answer', () => {
    const snap = build(SIDECHAIN)
    expect(snap.prompt).toBe('Fix the login form validation.\n\nUse `zod`.')
    expect(snap.cwd).toBe('/tmp/acme')
    expect(snap.result).toBe('Done: the password needs **8** characters.')
    expect(snap.entries.map((e) => e.kind)).toEqual(['thinking', 'text', 'tool', 'tool', 'tool'])
    expect(snap.entries[0]).toMatchObject({ kind: 'thinking', text: 'The schema lives in src/login.ts.', durationMs: 4000 })
    expect(snap.entries[2]).toMatchObject({
      kind: 'tool',
      name: 'Edit',
      title: 'Edited login.ts',
      status: 'completed',
      view: { kind: 'edit', path: '/tmp/acme/src/login.ts', edits: [{ oldText: 'min(1)', newText: 'min(8)' }] },
      result: { patch: [{ oldStart: 12, newStart: 12 }] }
    })
    expect(snap.entries[3]).toMatchObject({ name: 'Bash', status: 'failed', result: { exitCode: 1, isError: true }, at: T0 + 8000, endedAt: T0 + 20000 })
    expect(snap.entries[4]).toMatchObject({ name: 'Task', view: { kind: 'task', subagentType: 'Explore' }, result: { text: 'Two forms.' } })
  })

  it('keeps a running subagent open: no answer yet, the last call in progress', () => {
    const snap = build(SIDECHAIN.slice(0, 6))
    expect(snap.result).toBeUndefined()
    expect(snap.entries.at(-1)).toMatchObject({ name: 'Bash', status: 'in_progress' })
    expect((snap.entries.at(-1) as { result?: unknown }).result).toBeUndefined()
  })

  it('shows later messages to the subagent, skips unknown and broken lines, and bounds the list', () => {
    const snap = build([user(0, 'Go'), 'not json', JSON.stringify({ type: 'summary' }), assistant(1, 'a', [{ type: 'text', text: 'Hi' }], 'end_turn'), user(2, 'One more thing')])
    expect(snap.entries).toEqual([
      { kind: 'text', id: 'e1', text: 'Hi', at: T0 + 1000 },
      { kind: 'user', id: 'e2', text: 'One more thing', at: T0 + 2000 }
    ])
    expect(snap.result).toBeUndefined()

    const many = [user(0, 'Go'), ...Array.from({ length: CONVERSATION_LIMIT + 5 }, (_, i) => assistant(1, `m${i}`, [{ type: 'text', text: `t${i}` }]))]
    const bounded = build(many)
    expect(bounded.entries).toHaveLength(CONVERSATION_LIMIT)
    expect(bounded.omitted).toBe(5)
  })

  it('leaves out a thinking time that spans an idle gap', () => {
    const snap = build([user(0, 'Go'), assistant(3600, 'a', [{ type: 'thinking', thinking: '' }])])
    expect(snap.entries[0]).toMatchObject({ kind: 'thinking', text: '' })
    expect((snap.entries[0] as { durationMs?: number }).durationMs).toBeUndefined()
  })
})

describe('ClaudeTranscriptReader.subagent', () => {
  let dir: string | undefined
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = undefined
  })

  it('reads one subagent conversation with its summary and links the Task it started', async () => {
    dir = await mkdtemp(join(tmpdir(), 'wh-subagent-'))
    const session = 'abcdef01-2222-4333-8444-555555555555'
    const folder = join(dir, 'projects', '-tmp-acme')
    const subs = join(folder, session, 'subagents')
    await mkdir(subs, { recursive: true })
    await writeFile(
      join(folder, `${session}.jsonl`),
      [
        JSON.stringify({ type: 'user', cwd: '/tmp/acme', timestamp: ts(0), message: { role: 'user', content: 'Fix login' } }),
        JSON.stringify({ type: 'assistant', timestamp: ts(1), message: { id: 'p1', model: 'claude-opus-5', content: [{ type: 'tool_use', id: 'toolu_parent', name: 'Task', input: { subagent_type: 'general-purpose' } }] } })
      ].join('\n') + '\n'
    )
    await writeFile(join(subs, 'agent-a1.jsonl'), SIDECHAIN.join('\n') + '\n')
    await writeFile(join(subs, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'Fix the form', toolUseId: 'toolu_parent' }))
    await writeFile(join(subs, 'agent-a2.jsonl'), [user(22, 'Find other forms'), assistant(29, 'n1', [{ type: 'text', text: 'Two forms.' }], 'end_turn')].join('\n') + '\n')
    await writeFile(join(subs, 'agent-a2.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Find forms', toolUseId: 'tu_task' }))

    const reader = new ClaudeTranscriptReader({ now: () => T0 + 60_000 })
    const query = { agentSessionId: session, cwd: '/tmp/acme', configDir: dir }
    const conv = await reader.subagent(query, 'a1')
    expect(conv).toMatchObject({
      id: 'a1',
      type: 'general-purpose',
      description: 'Fix the form',
      model: 'claude-sonnet-5',
      status: 'completed',
      cwd: '/tmp/acme',
      prompt: 'Fix the login form validation.\n\nUse `zod`.',
      result: 'Done: the password needs **8** characters.',
      startedAt: T0
    })
    expect(conv?.tokens?.total).toBe(60)
    expect(conv?.entries.find((e) => e.kind === 'tool' && e.name === 'Task')).toMatchObject({ result: { agentId: 'a2', text: 'Two forms.' } })

    // The monitor names the parent call, so the main chat's Task card can open the subagent.
    const snap = await reader.read(query)
    expect(snap?.subagents?.find((s) => s.id === 'a1')?.toolUseId).toBe('toolu_parent')

    expect(await reader.subagent(query, 'missing')).toBeNull()
    expect(await reader.subagent(query, '../a1')).toBeNull()
  })
})

describe('ClaudeBridgeMapper tool views', () => {
  it('sends the view with the call and the result with its end', () => {
    const mapper = new ClaudeBridgeMapper('s1')
    const call = mapper.map({
      type: 'sdk',
      message: { type: 'assistant', message: { id: 'm', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } }
    })
    expect(call[0]).toMatchObject({ type: 'tool', toolCallId: 't1', view: { kind: 'command', command: 'npm test' } })
    const done = mapper.map({
      type: 'sdk',
      message: { type: 'user', tool_use_result: { stdout: 'ok' }, message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }
    })
    expect(done[0]).toMatchObject({ type: 'tool', toolCallId: 't1', status: 'completed', result: { text: 'ok', exitCode: 0 } })
  })
})

describe('ACP tool views', () => {
  it('shows a diff content item as an edit and a diff without old text as a new file', () => {
    expect(acpToolView({ kind: 'edit', content: [{ type: 'diff', path: '/r/a.ts', oldText: 'a\n', newText: 'b\n' }] })).toEqual({
      kind: 'edit',
      path: '/r/a.ts',
      edits: [{ oldText: 'a\n', newText: 'b\n' }]
    })
    expect(acpToolView({ kind: 'edit', content: [{ type: 'diff', path: '/r/new.ts', oldText: null, newText: 'x' }] })).toEqual({ kind: 'write', path: '/r/new.ts', content: 'x' })
  })

  it('reads commands, reads, searches and fetches from rawInput and locations', () => {
    expect(acpToolView({ kind: 'execute', rawInput: { command: ['npm', 'test'] } })).toEqual({ kind: 'command', command: 'npm test' })
    expect(acpToolView({ kind: 'read', locations: [{ path: '/r/a.ts', line: 4 }] })).toEqual({ kind: 'read', path: '/r/a.ts', offset: 4 })
    expect(acpToolView({ kind: 'search', rawInput: { pattern: 'TODO', path: 'src' } })).toEqual({ kind: 'search', tool: 'search', pattern: 'TODO', path: 'src' })
    expect(acpToolView({ kind: 'fetch', rawInput: { url: 'https://x.dev' } })).toEqual({ kind: 'fetch', url: 'https://x.dev' })
    expect(acpToolView({ kind: 'other', title: 'Think', rawInput: { topic: 'a' } })).toEqual({ kind: 'generic', tool: 'Think', args: [{ key: 'topic', value: 'a' }] })
    // An update with nothing beyond its status has no view: the chat keeps what it had.
    expect(acpToolView({ toolCallId: 't', status: 'completed' })).toBeUndefined()
  })

  it('takes the result from text content or raw output once the call ends', () => {
    expect(acpToolResult({ status: 'in_progress', content: [] })).toBeUndefined()
    expect(acpToolResult({ status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'ok' } }] })).toEqual({ text: 'ok' })
    expect(acpToolResult({ status: 'failed', rawOutput: { stdout: 'boom', exitCode: 3 } })).toEqual({ text: 'boom', isError: true, exitCode: 3 })
  })
})
