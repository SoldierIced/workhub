/**
 * Per-line token spend of each agent's transcripts, kept as small resumable states so a scan can
 * read only what was appended since the last one. Each parser adds to `SpendBuckets` (see
 * `@workhub/core` folder-spend) and never throws on malformed data.
 */
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { addSpend, type SpendBuckets } from '@workhub/core'
import { estimateCost } from '../shared/claude-tools'
import { openAiCost } from '../shared/openai-prices'
import { arr, num, obj, parseLine, str, toMillis, type Obj } from '../shared/reader-utils'

/**
 * What the spend cost at list prices, in the same keys as the token buckets: `usd` per bucket, and
 * `unpriced` tokens of models missing from the price tables. Only shown for API-key billing.
 */
export interface CostBuckets {
  usd: SpendBuckets
  unpriced: SpendBuckets
}

export const emptyCosts = (): CostBuckets => ({ usd: {}, unpriced: {} })

/** Adds a priced amount, or the tokens as unpriced when there is no price. */
function addCost(costs: CostBuckets | undefined, at: number, agent: 'claude' | 'codex', path: string, usd: number | undefined, tokens: number): void {
  if (!costs) return
  if (usd === undefined) addSpend(costs.unpriced, at, agent, path, tokens)
  else addSpend(costs.usd, at, agent, path, usd)
}

const CWD = /"cwd":"((?:[^"\\]|\\.)*)"/

/** The `cwd` field of a raw line, without parsing the whole line. */
function rawCwd(line: string): string | undefined {
  const m = CWD.exec(line)
  if (!m?.[1]) return undefined
  try {
    return JSON.parse(`"${m[1]}"`) as string
  } catch {
    return undefined
  }
}

/** A path a command or tool names: `~/x` and relative paths resolved; undefined when it is not a path. */
function resolvePath(raw: string, cwd: string | undefined, home: string): string | undefined {
  if (raw === '~' || raw.startsWith('~/')) return join(home, raw.slice(1))
  if (isAbsolute(raw)) return resolve(raw)
  if (cwd && !raw.startsWith('$') && !raw.startsWith('-')) return resolve(cwd, raw)
  return undefined
}

const CD = /(?:\bcd|git\s+-C)\s+("?)([^\s"';&|]+)/g

/** Resumable state of one Claude transcript. */
export interface ClaudeSpendState {
  /** The last `cwd` seen; a new one moves the work there. */
  cwd?: string
  /** Where the session works now: its cwd, or what its last edit or `cd` touched. */
  work?: string
  /** The message being streamed: its usage is repeated per block and the last copy counts. */
  pending?: { id: string; at: number; work: string; tokens: number; usd?: number; all?: number }
}

/**
 * One line of a Claude Code transcript. Tokens go to where the session was working when the
 * message was written: Workhub 1's rule, so a session started at a container folder counts for the
 * repository its edits and `cd`s touched. Reading files does not move the session.
 */
export function claudeSpendLine(line: string, state: ClaudeSpendState, buckets: SpendBuckets, home = homedir(), costs?: CostBuckets): void {
  const cwd = rawCwd(line)
  if (cwd && cwd !== state.cwd) {
    state.cwd = cwd
    state.work = cwd
  }
  // Only assistant messages carry usage and tool calls; user lines (tool results) can be huge.
  if (!line.includes('"assistant"')) return
  const entry = parseLine(line)
  const message = obj(entry?.['message'])
  if (!entry || entry['type'] !== 'assistant' || !message) return
  for (const block of arr(message['content'])) {
    const b = obj(block)
    if (b?.['type'] !== 'tool_use') continue
    const moved = workedPath(str(b['name']), obj(b['input']) ?? {}, state.cwd, home)
    if (moved) state.work = moved
  }
  const id = str(message['id'])
  const usage = obj(message['usage'])
  const at = toMillis(entry['timestamp'])
  if (!id || !usage || at === undefined || !state.work) return
  const input = num(usage['input_tokens']) ?? 0
  const cacheWrite = num(usage['cache_creation_input_tokens']) ?? 0
  const cacheRead = num(usage['cache_read_input_tokens']) ?? 0
  const output = num(usage['output_tokens']) ?? 0
  const tokens = input + cacheWrite + output
  const usd = estimateCost(str(message['model']), { input, cacheWrite, cacheRead, output }, true)?.amount
  if (state.pending && state.pending.id !== id) commitClaude(state, buckets, costs)
  state.pending = { id, at, work: state.work, tokens, all: tokens + cacheRead, ...(usd !== undefined ? { usd } : {}) }
}

/** Counts the message being streamed; called when the next one starts. */
export function commitClaude(state: ClaudeSpendState, buckets: SpendBuckets, costs?: CostBuckets): void {
  const p = state.pending
  if (p) {
    addSpend(buckets, p.at, 'claude', p.work, p.tokens)
    addCost(costs, p.at, 'claude', p.work, p.usd, p.all ?? p.tokens)
  }
  state.pending = undefined
}

/** The pending message as buckets of its own, so a scan can show it before it is committed. */
export function claudePending(state: ClaudeSpendState, costs?: CostBuckets): SpendBuckets {
  const out: SpendBuckets = {}
  const p = state.pending
  if (p) {
    addSpend(out, p.at, 'claude', p.work, p.tokens)
    addCost(costs, p.at, 'claude', p.work, p.usd, p.all ?? p.tokens)
  }
  return out
}

function workedPath(tool: string | undefined, input: Obj, cwd: string | undefined, home: string): string | undefined {
  switch (tool) {
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit': {
      const file = str(input['file_path']) ?? str(input['notebook_path'])
      const path = file ? resolvePath(file, cwd, home) : undefined
      return path ? dirname(path) : undefined
    }
    case 'Bash': {
      const command = str(input['command'])
      if (!command) return undefined
      let last: string | undefined
      for (const m of command.matchAll(CD)) last = m[2] ? resolvePath(m[2], cwd, home) : last
      return last
    }
    default:
      return undefined
  }
}

/** Resumable state of one Codex rollout. */
export interface CodexSpendState {
  cwd?: string
  /** Fresh tokens (input without cached + output) of the session so far, as last reported. */
  fresh?: number
  /** Totals come from `token_usage_record` lines (newer Codex) once one was seen. */
  records?: boolean
  /** The model of the current turn (`turn_context`), for the price. */
  model?: string
  /** The last running total, per part, to price the growth. */
  parts?: { input: number; cached: number; output: number }
  /** A ChatGPT plan's rate limits were reported: the session is not billed by API key. */
  plan?: boolean
}

/**
 * One line of a Codex rollout. `token_count` events (and, in newer rollouts, `token_usage_record`
 * lines, which then win) carry the session's running totals, so the spend is the growth of the
 * fresh total since the previous one: a repeated total adds nothing.
 */
export function codexSpendLine(line: string, state: CodexSpendState, buckets: SpendBuckets, costs?: CostBuckets): void {
  if (!line.includes('session_meta') && !line.includes('turn_context') && !line.includes('token_count') && !line.includes('token_usage_record')) return
  const entry = parseLine(line)
  const payload = obj(entry?.['payload'])
  if (!entry || !payload) return
  if (entry['type'] === 'session_meta' || entry['type'] === 'turn_context') {
    state.cwd = str(payload['cwd']) ?? state.cwd
    if (entry['type'] === 'turn_context') state.model = str(payload['model']) ?? state.model
    return
  }
  if (entry['type'] === 'event_msg' && payload['type'] === 'token_count') {
    const limits = obj(payload['rate_limits'])
    if (limits && (obj(limits['primary']) || obj(limits['secondary']) || str(limits['plan_type']))) state.plan = true
  }
  let total: Obj | undefined
  // The last request's usage: over 272K input tokens it is billed at the long-context price.
  let request: Obj | undefined
  if (entry['type'] === 'token_usage_record') {
    total = obj(payload['thread_token_usage'])
    request = obj(payload['usage'])
    // The same running total as token_count's: the growth carries on from it.
    if (total) state.records = true
  } else if (entry['type'] === 'event_msg' && payload['type'] === 'token_count' && !state.records) {
    total = obj(obj(payload['info'])?.['total_token_usage'])
    request = obj(obj(payload['info'])?.['last_token_usage'])
  }
  if (!total) return
  const input = num(total['input_tokens']) ?? 0
  const cached = num(total['cached_input_tokens']) ?? 0
  const output = num(total['output_tokens']) ?? 0
  const fresh = Math.max(0, input - cached) + output
  const prev = state.fresh ?? 0
  // A total that went down started counting again (a new session in the same file).
  const restarted = fresh < prev
  const delta = restarted ? fresh : fresh - prev
  state.fresh = fresh
  const at = toMillis(entry['timestamp'])
  addSpend(buckets, at, 'codex', state.cwd, delta)
  const last = !restarted && state.parts ? state.parts : { input: 0, cached: 0, output: 0 }
  state.parts = { input, cached, output }
  if (at !== undefined && state.cwd && delta > 0) {
    const grown = { input: Math.max(0, input - cached - (last.input - last.cached)), cached: Math.max(0, cached - last.cached), output: Math.max(0, output - last.output) }
    addCost(costs, at, 'codex', state.cwd, openAiCost(state.model, grown, num(request?.['input_tokens'])), grown.input + grown.cached + grown.output)
  }
}

/**
 * The tokens of a Kiro ACP session file (`sessions/cli/<id>.json`): each turn's input, cache write
 * and output, at the turn's end (the file's update time when a turn has none), in the session's
 * cwd. Kiro's chat sessions record credits but no tokens, so they add nothing here.
 */
export function kiroSpendFile(text: string, buckets: SpendBuckets): void {
  let raw: Obj | undefined
  try {
    raw = obj(JSON.parse(text))
  } catch {
    return
  }
  const cwd = str(raw?.['cwd'])
  const fallback = toMillis(raw?.['updated_at'])
  const turns = arr(obj(obj(raw?.['session_state'])?.['conversation_metadata'])?.['user_turn_metadatas'])
  for (const t of turns) {
    const turn = obj(t)
    if (!turn) continue
    const tokens = (num(turn['input_token_count']) ?? 0) + (num(turn['cache_write_input_token_count']) ?? 0) + (num(turn['output_token_count']) ?? 0)
    addSpend(buckets, toMillis(turn['end_timestamp']) ?? fallback, 'kiro', cwd, tokens)
  }
}
