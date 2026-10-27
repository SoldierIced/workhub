/**
 * Claude Code tool calls as structured views (an edit's old and new text, a command and its
 * exit status, a search and its match count), from the `tool_use` input and the `tool_result`
 * Claude Code writes back. Pure; every field is optional and anything unknown becomes a generic
 * view of the call's arguments. Sizes are bounded so a huge file never travels to the renderer.
 */
import { clip, type FileEdit, type PatchHunk, type TodoItem, type ToolArg, type ToolResultView, type ToolView } from '@workhub/core'

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj | undefined => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const s = (input: Obj, key: string): string => (typeof input[key] === 'string' ? (input[key] as string) : '')
const opt = (input: Obj, key: string): string | undefined => s(input, key) || undefined
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/** Most characters of one edit side, of written content and of a result. */
export const EDIT_TEXT_LIMIT = 100_000
export const RESULT_TEXT_LIMIT = 20_000
const ARG_LIMIT = 160
const ARGS_SHOWN = 6
const PATCH_LINES = 2_000

const bounded = (text: string, max = EDIT_TEXT_LIMIT): string => clip(text, max).text

/** Arguments in a line each: strings as they are, anything else as compact JSON, both cut short. */
export function argSummary(input: Obj): ToolArg[] {
  return Object.entries(input)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .slice(0, ARGS_SHOWN)
    .map(([key, v]) => {
      const text = typeof v === 'string' ? v : JSON.stringify(v)
      const one = text.replace(/\s+/g, ' ').trim()
      return { key, value: one.length > ARG_LIMIT ? `${one.slice(0, ARG_LIMIT - 1)}…` : one }
    })
}

function todoStatus(v: unknown): TodoItem['status'] {
  return v === 'completed' || v === 'in_progress' ? v : 'pending'
}

/** The view of one `tool_use` block. */
export function claudeToolView(tool: string, input: Obj): ToolView {
  switch (tool) {
    case 'Edit':
      return {
        kind: 'edit',
        path: s(input, 'file_path'),
        edits: [{ oldText: bounded(s(input, 'old_string')), newText: bounded(s(input, 'new_string')), ...(input['replace_all'] === true ? { replaceAll: true } : {}) }]
      }
    case 'MultiEdit': {
      const edits: FileEdit[] = arr(input['edits']).flatMap((raw) => {
        const e = obj(raw)
        if (!e) return []
        return [{ oldText: bounded(s(e, 'old_string')), newText: bounded(s(e, 'new_string')), ...(e['replace_all'] === true ? { replaceAll: true } : {}) }]
      })
      return { kind: 'edit', path: s(input, 'file_path'), edits }
    }
    case 'Write':
      return { kind: 'write', path: s(input, 'file_path'), content: bounded(s(input, 'content')) }
    case 'NotebookEdit':
      return { kind: 'write', path: s(input, 'notebook_path'), content: bounded(s(input, 'new_source')) }
    case 'Read': {
      const view: ToolView = { kind: 'read', path: s(input, 'file_path') }
      const offset = num(input['offset'])
      const limit = num(input['limit'])
      if (offset !== undefined) view.offset = offset
      if (limit !== undefined) view.limit = limit
      return view
    }
    case 'Grep':
    case 'Glob': {
      const view: ToolView = { kind: 'search', tool, pattern: s(input, 'pattern') }
      const path = opt(input, 'path')
      const glob = opt(input, 'glob') ?? opt(input, 'type')
      if (path) view.path = path
      if (glob) view.glob = glob
      return view
    }
    case 'Bash': {
      const view: ToolView = { kind: 'command', command: bounded(s(input, 'command'), RESULT_TEXT_LIMIT) }
      const description = opt(input, 'description')
      if (description) view.description = description
      return view
    }
    case 'WebFetch': {
      const view: ToolView = { kind: 'fetch', url: s(input, 'url') }
      const prompt = opt(input, 'prompt')
      if (prompt) view.prompt = prompt
      return view
    }
    case 'WebSearch':
      return { kind: 'webSearch', query: s(input, 'query') }
    case 'Agent':
    case 'Task': {
      const view: ToolView = { kind: 'task' }
      const type = opt(input, 'subagent_type')
      const description = opt(input, 'description')
      const prompt = opt(input, 'prompt')
      if (type) view.subagentType = type
      if (description) view.description = description
      if (prompt) view.prompt = bounded(prompt, RESULT_TEXT_LIMIT)
      return view
    }
    case 'TodoWrite':
      return {
        kind: 'todo',
        items: arr(input['todos']).flatMap((raw) => {
          const t = obj(raw)
          const text = t ? s(t, 'content') || s(t, 'activeForm') : ''
          return t && text ? [{ text, status: todoStatus(t['status']) }] : []
        })
      }
    default:
      if (tool.startsWith('mcp__')) {
        const [server = '', ...rest] = tool.slice(5).split('__')
        return { kind: 'mcp', server, tool: rest.join('__'), args: argSummary(input) }
      }
      return { kind: 'generic', tool, args: argSummary(input) }
  }
}

/** Text of a tool result: a string, or the text parts of a content list. */
export function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  return arr(content)
    .map((p) => {
      const part = obj(p)
      return typeof part?.['text'] === 'string' ? (part['text'] as string) : ''
    })
    .filter(Boolean)
    .join('\n')
}

function patchOf(raw: unknown): PatchHunk[] | undefined {
  let budget = PATCH_LINES
  const hunks = arr(raw).flatMap((h): PatchHunk[] => {
    const o = obj(h)
    const oldStart = num(o?.['oldStart'])
    const newStart = num(o?.['newStart'])
    const lines = arr(o?.['lines']).filter((l): l is string => typeof l === 'string')
    if (!o || oldStart === undefined || newStart === undefined || !lines.length || budget <= 0) return []
    const kept = lines.slice(0, budget)
    budget -= kept.length
    return [{ oldStart, newStart, lines: kept.map((l) => bounded(l, 2_000)) }]
  })
  // A cut patch would show a partial edit as the whole one; the old/new diff is the fallback.
  return hunks.length && budget > 0 ? hunks : undefined
}

/**
 * The view of a `tool_result` block. `extra` is the entry's `toolUseResult`, the structured
 * result Claude Code keeps beside the text (Bash stdout, a Grep's counts, an Edit's patch).
 */
export function claudeToolResult(tool: string, content: unknown, isError: boolean, extra?: unknown): ToolResultView {
  const raw = resultText(content)
  const { text, truncated } = clip(raw, RESULT_TEXT_LIMIT)
  const result: ToolResultView = {}
  if (text) result.text = text
  if (truncated) result.truncated = true
  if (isError) result.isError = true
  const x = obj(extra)
  switch (tool) {
    case 'Bash': {
      const code = /^(?:Error: )?Exit code (\d+)/.exec(raw)?.[1]
      if (code !== undefined) result.exitCode = Number(code)
      else if (!isError && x?.['interrupted'] !== true) result.exitCode = 0
      break
    }
    case 'Grep':
    case 'Glob': {
      const count = num(x?.['numMatches']) ?? num(x?.['numLines']) ?? num(x?.['numFiles'])
      if (count !== undefined) result.matchCount = count
      else if (/^No (files|matches) found/.test(raw)) result.matchCount = 0
      else {
        const found = /^Found (\d+)/.exec(raw)?.[1]
        result.matchCount = found !== undefined ? Number(found) : raw.split('\n').filter((l) => l.trim()).length
      }
      break
    }
    case 'Read': {
      const lines = num(obj(x?.['file'])?.['numLines'])
      if (lines !== undefined) result.lineCount = lines
      break
    }
    case 'Edit':
    case 'MultiEdit': {
      const patch = patchOf(x?.['structuredPatch'])
      if (patch) result.patch = patch
      break
    }
    case 'Agent':
    case 'Task': {
      const agentId = typeof x?.['agentId'] === 'string' ? (x['agentId'] as string) : undefined
      if (agentId) result.agentId = agentId
      break
    }
  }
  return result
}
