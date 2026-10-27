/**
 * Hand-off facts out of a Claude Code transcript (`<config>/projects/<folder>/<id>.jsonl`): the
 * first prompt, the files edited, the commands run, the latest task list (TodoWrite, or the newer
 * TaskCreate / TaskUpdate), links and the user/assistant exchanges. Pure over lines, so it runs
 * on synthetic fixtures; `readClaudeHandoffFacts` only finds and reads the file.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { HandoffFacts, TodoStatus } from '@workhub/core'
import { ClaudeTranscriptParser } from './parser'
import { findSessionFolder } from './session-copy'

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj | undefined => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined)

const EDIT_TOOLS: Record<string, string> = { Edit: 'file_path', MultiEdit: 'file_path', Write: 'file_path', NotebookEdit: 'notebook_path' }
const STATUSES = new Set<TodoStatus>(['pending', 'in_progress', 'completed'])
const status = (v: unknown): TodoStatus => (STATUSES.has(v as TodoStatus) ? (v as TodoStatus) : 'pending')

/** Text a user typed, without the wrappers Claude Code adds for local commands and reminders. */
function typed(text: string | undefined): string | undefined {
  if (!text) return undefined
  if (text.includes('<command-name>') || text.includes('<local-command') || text.startsWith('<system-reminder>') || text.startsWith('Caveat:')) return undefined
  return text.trim() || undefined
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  return arr(content)
    .map((p) => str(obj(p)?.['text']) ?? '')
    .join('\n')
}

export function claudeHandoffFacts(lines: Iterable<string>, ticketPrefixes: readonly string[] = []): HandoffFacts {
  const parser = new ClaudeTranscriptParser({ ticketPrefixes })
  const facts: HandoffFacts = { pullRequests: [], tickets: [], filesTouched: [], commands: [], todos: [], exchanges: [] }
  let todoList: HandoffFacts['todos'] | null = null
  const tasks = new Map<string, { text: string; status: TodoStatus }>()
  const pendingCreates = new Map<string, string>()

  for (const line of lines) {
    if (!line.trim()) continue
    parser.ingest(line)
    let e: Obj | undefined
    try {
      e = obj(JSON.parse(line))
    } catch {
      continue
    }
    // Subagent turns and harness-injected messages are not the conversation.
    if (!e || e['isSidechain'] === true || e['isMeta'] === true) continue
    const content = obj(e['message'])?.['content']
    if (e['type'] === 'user') {
      if (typeof content === 'string') {
        const text = typed(content)
        if (text) facts.exchanges.push({ role: 'user', text })
        continue
      }
      const blocks = arr(content).map(obj).filter((b): b is Obj => !!b)
      for (const b of blocks) {
        const created = b['type'] === 'tool_result' ? pendingCreates.get(str(b['tool_use_id']) ?? '') : undefined
        if (created !== undefined) {
          pendingCreates.delete(str(b['tool_use_id'])!)
          const id = /#?(\d+)/.exec(resultText(b['content']))?.[1] ?? String(tasks.size + 1)
          tasks.set(id, { text: created, status: 'pending' })
        }
      }
      const text = typed(blocks.filter((b) => b['type'] === 'text').map((b) => str(b['text']) ?? '').join('\n'))
      if (text) facts.exchanges.push({ role: 'user', text })
    } else if (e['type'] === 'assistant') {
      for (const raw of arr(content)) {
        const b = obj(raw)
        if (b?.['type'] === 'text' && str(b['text'])) {
          const last = facts.exchanges[facts.exchanges.length - 1]
          if (last?.role === 'agent') last.text += `\n\n${b['text'] as string}`
          else facts.exchanges.push({ role: 'agent', text: b['text'] as string })
          continue
        }
        if (b?.['type'] !== 'tool_use') continue
        const name = str(b['name']) ?? ''
        const input = obj(b['input']) ?? {}
        const pathKey = EDIT_TOOLS[name]
        const path = pathKey ? str(input[pathKey]) : undefined
        if (path && !facts.filesTouched.includes(path)) facts.filesTouched.push(path)
        if (name === 'Bash' && str(input['command'])) facts.commands.push(input['command'] as string)
        if (name === 'TodoWrite') {
          todoList = arr(input['todos']).flatMap((t) => {
            const o = obj(t)
            const text = str(o?.['content'])
            return text ? [{ text, status: status(o?.['status']) }] : []
          })
        }
        if (name === 'TaskCreate' && str(input['subject']) && str(b['id'])) pendingCreates.set(b['id'] as string, input['subject'] as string)
        if (name === 'TaskUpdate' && str(input['taskId'])) {
          const id = input['taskId'] as string
          if (input['status'] === 'deleted') tasks.delete(id)
          else {
            const prev = tasks.get(id) ?? { text: str(input['subject']) ?? `Task ${id}`, status: 'pending' as TodoStatus }
            tasks.set(id, { text: str(input['subject']) ?? prev.text, status: input['status'] ? status(input['status']) : prev.status })
          }
        }
      }
    }
  }

  const snap = parser.snapshot()
  if (snap.title) facts.title = snap.title
  facts.pullRequests = snap.pullRequests ?? []
  facts.tickets = snap.ticketKeys ?? []
  facts.goal = facts.exchanges.find((m) => m.role === 'user')?.text
  if (!facts.goal) delete facts.goal
  facts.todos = tasks.size ? [...tasks.values()] : (todoList ?? [])
  return facts
}

/** Reads the session's transcript in its account folder; null when it is not there. */
export async function readClaudeHandoffFacts(input: { sessionId: string; cwd: string; configDir: string; ticketPrefixes?: readonly string[] }): Promise<HandoffFacts | null> {
  const folder = await findSessionFolder(input.configDir, input.sessionId, input.cwd)
  if (!folder) return null
  const text = await readFile(join(input.configDir, 'projects', folder, `${input.sessionId}.jsonl`), 'utf8').catch(() => null)
  return text === null ? null : claudeHandoffFacts(text.split('\n'), input.ticketPrefixes)
}
