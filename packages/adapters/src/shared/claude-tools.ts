/**
 * Claude Code facts shared by the transcript reader and the native adapter: tool calls described
 * in words, list prices, and the pull requests and ticket keys a session names. Ported from
 * Workhub 1 (`StepDescription`, `Pricing`, `TicketKey`, `TicketLinks`).
 */
import type { Money, TokenUsage } from '@workhub/core'

type Obj = Record<string, unknown>

const str = (input: Obj, key: string): string => (typeof input[key] === 'string' ? (input[key] as string) : '')
const base = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path

function host(url: string): string {
  const m = /^[a-z]+:\/\/([^/?#]+)/i.exec(url)
  return m?.[1] ?? url
}

/** One tool call in words, as Workhub 1's monitor shows it: a title and the command, path or URL behind it. */
export function describeTool(tool: string, input: Obj): { title: string; detail: string } {
  switch (tool) {
    case 'Bash':
      return { title: str(input, 'description') || 'Ran a command', detail: `$ ${str(input, 'command')}` }
    case 'Read':
      return { title: `Read ${base(str(input, 'file_path'))}`, detail: str(input, 'file_path') }
    case 'Edit':
    case 'MultiEdit':
      return { title: `Edited ${base(str(input, 'file_path'))}`, detail: str(input, 'file_path') }
    case 'Write':
      return { title: `Wrote ${base(str(input, 'file_path'))}`, detail: str(input, 'file_path') }
    case 'NotebookEdit':
      return { title: `Edited ${base(str(input, 'notebook_path'))}`, detail: str(input, 'notebook_path') }
    case 'Grep':
      return { title: `Searched the code for "${str(input, 'pattern')}"`, detail: str(input, 'path') }
    case 'Glob':
      return { title: `Listed files matching ${str(input, 'pattern')}`, detail: str(input, 'path') }
    case 'Agent':
    case 'Task':
      return { title: `Started a ${str(input, 'subagent_type') || 'general-purpose'} subagent`, detail: str(input, 'description') }
    case 'WebFetch':
      return { title: `Fetched ${host(str(input, 'url'))}`, detail: str(input, 'url') }
    case 'WebSearch':
      return { title: `Searched the web for "${str(input, 'query')}"`, detail: '' }
    case 'Skill':
      return { title: `Loaded the ${str(input, 'skill')} skill`, detail: str(input, 'args') }
    case 'AskUserQuestion':
      return { title: 'Asked you a question', detail: '' }
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
      return { title: 'Updated the task list', detail: '' }
    case 'ExitPlanMode':
      return { title: 'Proposed a plan', detail: '' }
    default:
      if (tool.startsWith('mcp__')) {
        const [server, ...rest] = tool.slice(5).split('__')
        return { title: `Called ${server}: ${rest.join(' ').replaceAll('_', ' ')}`, detail: '' }
      }
      return { title: tool, detail: '' }
  }
}

/** ACP-style kind of a Claude tool, for the chat's icons. */
export function toolKind(tool: string): string {
  switch (tool) {
    case 'Read':
      return 'read'
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return 'edit'
    case 'Bash':
      return 'execute'
    case 'Grep':
    case 'Glob':
    case 'WebSearch':
      return 'search'
    case 'WebFetch':
      return 'fetch'
    default:
      return 'other'
  }
}

/**
 * List prices in USD per million tokens (Workhub 1's table, the same as `/monitor`). Claude Code
 * writes the prompt cache with a 1-hour TTL, billed at twice the input price. First match wins.
 */
const PRICES: readonly { match: string; input: number; output: number; cacheRead: number }[] = [
  { match: 'fable-5-1', input: 10, output: 50, cacheRead: 0.25 },
  { match: 'mythos-5-1', input: 10, output: 50, cacheRead: 0.25 },
  { match: 'fable', input: 10, output: 50, cacheRead: 1 },
  { match: 'mythos', input: 10, output: 50, cacheRead: 1 },
  { match: 'opus-5-5', input: 4, output: 20, cacheRead: 0.2 },
  { match: 'opus', input: 5, output: 25, cacheRead: 0.5 },
  { match: 'sonnet-5', input: 2, output: 10, cacheRead: 0.2 },
  { match: 'sonnet', input: 3, output: 15, cacheRead: 0.3 },
  { match: 'haiku', input: 1, output: 5, cacheRead: 0.1 }
]

/** Estimated cost at list prices; undefined for a model missing from the table. */
export function estimateCost(model: string | undefined, tokens: TokenUsage): Money | undefined {
  const price = model ? PRICES.find((p) => model.includes(p.match)) : undefined
  if (!price) return undefined
  const total =
    (tokens.input ?? 0) * price.input +
    (tokens.cacheWrite ?? 0) * price.input * 2 +
    (tokens.cacheRead ?? 0) * price.cacheRead +
    (tokens.output ?? 0) * price.output
  return { amount: total / 1_000_000, currency: 'USD' }
}

/** Context window of a model: 1M for Opus 5, Fable and `[1m]` models (or when more is in use), else 200k. */
export function contextWindow(model: string | undefined, used: number): number {
  if (!model) return 200_000
  if (model.includes('[1m]') || model.includes('opus-5') || model.includes('fable') || used > 200_000) return 1_000_000
  return 200_000
}

const PR_URL = /https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)|https?:\/\/[A-Za-z0-9.-]*gitlab[A-Za-z0-9.-]*\/([A-Za-z0-9_./-]+?)\/-\/merge_requests\/(\d+)/g

/** Pull and merge request URLs in a text, canonical (lowercase, no trailing path), in order, once each. */
export function pullRequestUrls(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(PR_URL)) {
    const url = m[1]
      ? `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}`.toLowerCase()
      : `${m[0].slice(0, m[0].indexOf('/-/merge_requests/'))}/-/merge_requests/${m[5]}`.toLowerCase()
    if (!out.includes(url)) out.push(url)
  }
  return out
}

/** Key-like words that are not tickets. */
const NOT_TICKETS = new Set(['UTF', 'ISO', 'SHA', 'MD', 'RFC', 'HTTP', 'TLS', 'SSL', 'UTC', 'GMT', 'AES', 'RSA', 'CVE', 'ES', 'PEP', 'X', 'TOP', 'PHASE', 'STEP', 'V'])

/**
 * Ticket keys (`ABC-123`) in a text, uppercased, in order. With project prefixes only those
 * projects count; without them any key-like word does, minus common non-ticket words.
 */
export function ticketKeys(text: string, prefixes: readonly string[] = []): string[] {
  const wanted = prefixes.map((p) => p.trim().toUpperCase()).filter(Boolean)
  const pattern = wanted.length
    ? new RegExp(`\\b(${wanted.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})-(\\d+)\\b`, 'gi')
    : /\b([A-Z][A-Z0-9]{1,9})-(\d+)\b/g
  const out: string[] = []
  for (const m of text.matchAll(pattern)) {
    const project = (m[1] ?? '').toUpperCase()
    if (!wanted.length && NOT_TICKETS.has(project)) continue
    const key = `${project}-${m[2]}`
    if (!out.includes(key)) out.push(key)
  }
  return out
}

/** Jira tools of an Atlassian MCP, except the ones that list many unrelated issues (Workhub 1's rule). */
export function isJiraTool(tool: string): boolean {
  const name = tool.toLowerCase()
  return name.startsWith('mcp__') && (name.includes('atlassian') || name.includes('jira')) && !name.includes('search') && !name.includes('visiblejira') && !name.includes('fetch')
}
