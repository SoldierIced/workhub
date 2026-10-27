/**
 * ACP `tool_call` / `tool_call_update` as a structured view, from what the spec carries: `diff`
 * content (path, oldText, newText) for edits, `locations` for reads, `rawInput` for commands and
 * searches, and `content` text or `rawOutput` for the result. Pure. Nothing is made up: a call
 * without usable data has no view and keeps the plain row.
 */
import { clip, type ToolResultView, type ToolView } from '@workhub/core'
import { argSummary, EDIT_TEXT_LIMIT, RESULT_TEXT_LIMIT } from '../shared/claude-tool-view'

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj | undefined => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

function command(raw: Obj | undefined): string | undefined {
  const c = raw?.['command'] ?? raw?.['cmd']
  if (typeof c === 'string' && c) return c
  const parts = arr(c).filter((p): p is string => typeof p === 'string')
  return parts.length ? parts.join(' ') : undefined
}

/** The view of one update, or undefined when it carries nothing to show beyond the title. */
export function acpToolView(update: Obj): ToolView | undefined {
  const content = arr(update['content']).map(obj).filter((c): c is Obj => !!c)
  const raw = obj(update['rawInput'])
  const diffs = content.filter((c) => c['type'] === 'diff' && str(c['path']))
  if (diffs.length) {
    const path = diffs[0]!['path'] as string
    const same = diffs.filter((d) => d['path'] === path)
    const edits = same.map((d) => ({
      oldText: clip(typeof d['oldText'] === 'string' ? d['oldText'] : '', EDIT_TEXT_LIMIT).text,
      newText: clip(typeof d['newText'] === 'string' ? d['newText'] : '', EDIT_TEXT_LIMIT).text
    }))
    // A diff without old text is a new file.
    if (edits.length === 1 && !same[0]!['oldText']) return { kind: 'write', path, content: edits[0]!.newText }
    return { kind: 'edit', path, edits }
  }
  const kind = str(update['kind'])
  const location = obj(arr(update['locations'])[0])
  const path = str(location?.['path']) ?? str(raw?.['path']) ?? str(raw?.['file_path']) ?? str(raw?.['filePath'])
  switch (kind) {
    case 'execute': {
      const cmd = command(raw)
      if (!cmd) return undefined
      const view: ToolView = { kind: 'command', command: clip(cmd, RESULT_TEXT_LIMIT).text }
      const description = str(raw?.['description'])
      if (description) view.description = description
      return view
    }
    case 'read': {
      if (!path) return undefined
      const view: ToolView = { kind: 'read', path }
      const line = num(location?.['line']) ?? num(raw?.['offset'])
      const limit = num(raw?.['limit'])
      if (line !== undefined) view.offset = line
      if (limit !== undefined) view.limit = limit
      return view
    }
    case 'search': {
      const pattern = str(raw?.['pattern']) ?? str(raw?.['query'])
      if (!pattern) return undefined
      const view: ToolView = { kind: 'search', tool: 'search', pattern }
      if (path) view.path = path
      return view
    }
    case 'fetch': {
      const url = str(raw?.['url'])
      if (url) return { kind: 'fetch', url }
      const query = str(raw?.['query'])
      return query ? { kind: 'webSearch', query } : undefined
    }
    default:
      return raw && Object.keys(raw).length ? { kind: 'generic', tool: str(update['title']) ?? kind ?? 'tool', args: argSummary(raw) } : undefined
  }
}

/** The result of an update that ended the call: its text content, or its raw output. */
export function acpToolResult(update: Obj): ToolResultView | undefined {
  const status = str(update['status'])
  if (status !== 'completed' && status !== 'failed') return undefined
  const texts = arr(update['content'])
    .map(obj)
    .flatMap((c) => {
      const inner = obj(c?.['content'])
      return c?.['type'] === 'content' && inner?.['type'] === 'text' && typeof inner['text'] === 'string' ? [inner['text'] as string] : []
    })
  const output = update['rawOutput']
  const outObj = obj(output)
  const fallback = typeof output === 'string' ? output : (str(outObj?.['output']) ?? str(outObj?.['stdout']) ?? '')
  const { text, truncated } = clip(texts.length ? texts.join('\n') : fallback, RESULT_TEXT_LIMIT)
  const result: ToolResultView = {}
  if (text) result.text = text
  if (truncated) result.truncated = true
  if (status === 'failed') result.isError = true
  const exit = num(outObj?.['exitCode']) ?? num(outObj?.['exit_code'])
  if (exit !== undefined) result.exitCode = exit
  return result
}
