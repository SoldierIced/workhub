/**
 * Hand-off to another agent: Workhub writes a brief of a session (goal, links, files, commands,
 * open TODOs, the last exchanges) and drafts it in a new session of another agent in the same
 * folder. A brief is a summary, not the transcript: the other agent starts a new conversation.
 * Pure: facts in, Markdown out, so the shape and the size budget are tested on fixtures.
 */
import { accountAgentId } from '../domain/agent'
import type { SessionMonitorSnapshot } from '../domain/monitor'
import type { Profile } from '../domain/profile'
import type { HistoryMessage } from '../ports'
import type { EffectiveAgent } from '../usecases/effective-agents'
import { orderAgents } from '../usecases/pick-agent'

export type TodoStatus = 'pending' | 'in_progress' | 'completed'

/** What a brief is made of; every list may be empty. */
export interface HandoffFacts {
  title?: string
  /** The first thing the user asked. */
  goal?: string
  pullRequests: string[]
  tickets: string[]
  /** Files the session edited or wrote, oldest first, without repeats. */
  filesTouched: string[]
  /** Shell commands the session ran, oldest first. */
  commands: string[]
  /** The session's latest task list. */
  todos: { text: string; status: TodoStatus }[]
  /** User and agent messages in order (no tool calls). */
  exchanges: { role: 'user' | 'agent'; text: string }[]
}

export const EMPTY_FACTS: HandoffFacts = { pullRequests: [], tickets: [], filesTouched: [], commands: [], todos: [], exchanges: [] }

/** The repository the session worked in, as git reports it now. */
export interface GitSnapshot {
  branch?: string | null
  /** Paths with uncommitted changes. */
  dirtyFiles: string[]
}

export interface BriefOptions {
  /** "Claude - Personal". */
  sourceLabel: string
  cwd: string
  git?: GitSnapshot | null
  /** A summary the source agent wrote (the "Ask the agent to summarize" option); replaces the last exchanges. */
  summary?: string
  /** Size budget of the whole brief, in characters (default 12 000). */
  maxChars?: number
  /** At most this many of the last messages (default 8). */
  exchanges?: number
}

export const DEFAULT_BRIEF_CHARS = 12_000
const MAX_FILES = 30
const MAX_COMMANDS = 15
const MAX_DIRTY = 20
const GOAL_CHARS = 1_500
const MESSAGE_CHARS = 1_500
const COMMAND_CHARS = 200

/** One line, at most `max` characters, with an ellipsis when cut. */
function clip(text: string, max: number): string {
  const t = text.trim()
  return t.length <= max ? t : `${t.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

function lastUnique(list: readonly string[], max: number): { shown: string[]; more: number } {
  const unique = [...new Set(list.map((s) => s.trim()).filter(Boolean))]
  return { shown: unique.slice(-max), more: Math.max(0, unique.length - max) }
}

function section(title: string, lines: string[]): string {
  return lines.length ? `## ${title}\n${lines.join('\n')}` : ''
}

/** Text in a code span, safe when it holds backticks. */
function code(text: string): string {
  const fence = text.includes('`') ? '``' : '`'
  return `${fence}${text}${fence}`
}

/**
 * The brief, in Markdown. Fixed sections first (each bounded), then the last exchanges, newest
 * kept first, as far as the budget allows; the result never exceeds `maxChars`.
 */
export function buildHandoffBrief(facts: HandoffFacts, options: BriefOptions): string {
  const max = options.maxChars ?? DEFAULT_BRIEF_CHARS
  const intro = [
    `# Hand-off from ${options.sourceLabel}`,
    '',
    `You are taking over a coding session that ${options.sourceLabel} worked on in ${code(options.cwd)}. ` +
      'This is a summary of that session, not its full conversation: check the repository before acting, and ask me when something is unclear.'
  ].join('\n')

  const goal = facts.goal ? section('Goal', [clip(facts.goal, GOAL_CHARS)]) : ''
  const links = section('Links', [...facts.tickets.map((k) => `- Ticket ${k}`), ...facts.pullRequests.map((u) => `- ${u}`)])

  const repo: string[] = []
  if (options.git) {
    if (options.git.branch) repo.push(`- Branch: ${code(options.git.branch)}`)
    const dirty = lastUnique(options.git.dirtyFiles, MAX_DIRTY)
    repo.push(dirty.shown.length ? `- Uncommitted changes: ${dirty.shown.map(code).join(', ')}${dirty.more ? ` (+${dirty.more} more)` : ''}` : '- No uncommitted changes')
  }
  const repository = section('Repository now', repo)

  const files = lastUnique(facts.filesTouched, MAX_FILES)
  const filesSection = section('Files touched', [...files.shown.map((f) => `- ${code(f)}`), ...(files.more ? [`- …and ${files.more} more`] : [])])
  const commands = lastUnique(facts.commands, MAX_COMMANDS)
  const commandsSection = section('Commands run (latest)', commands.shown.map((c) => `- ${code(clip(c.replace(/\s+/g, ' '), COMMAND_CHARS))}`))
  const open = facts.todos.filter((t) => t.status !== 'completed')
  const todos = section('Open TODOs', open.map((t) => `- [ ] ${clip(t.text, 300)}${t.status === 'in_progress' ? ' (in progress)' : ''}`))
  const summary = options.summary?.trim() ? section(`Summary by ${options.sourceLabel}`, [options.summary.trim()]) : ''
  const next = section('Next step', ['Read the repository state above, then continue from where the session left off. Tell me what you plan to do before large changes.'])

  const fixed = options.summary?.trim() ? [intro, goal, summary, links, repository, todos] : [intro, goal, links, repository, filesSection, commandsSection, todos]
  let head = fixed.filter(Boolean).join('\n\n')
  const tail = `\n\n${next}`
  // The fixed part alone over budget: cut it (the Next step is kept).
  if (head.length + tail.length > max) return clip(head, Math.max(0, max - tail.length)) + tail

  if (!options.summary?.trim()) {
    const room = max - head.length - tail.length - '\n\n## Last exchanges\n'.length
    const picked: string[] = []
    let used = 0
    const recent = facts.exchanges.slice(-(options.exchanges ?? 8)).reverse()
    for (const m of recent) {
      const who = m.role === 'user' ? 'User' : options.sourceLabel
      const line = `**${who}:** ${clip(m.text, MESSAGE_CHARS)}`
      if (used + line.length + 2 > room) break
      picked.unshift(line)
      used += line.length + 2
    }
    if (picked.length) head += `\n\n## Last exchanges\n${picked.join('\n\n')}`
  }
  return head + tail
}

/**
 * Facts out of any agent's replayed history (the `SessionHistorySource` messages) and its monitor
 * snapshot: the first user message is the goal, edits and writes are the files touched, `$ …`
 * tool details are the commands. Agents whose transcripts are richer (Claude) have their own.
 */
export function factsFromHistory(messages: readonly HistoryMessage[], monitor: SessionMonitorSnapshot = {}): HandoffFacts {
  const facts: HandoffFacts = { ...EMPTY_FACTS, pullRequests: [...(monitor.pullRequests ?? [])], tickets: [...(monitor.ticketKeys ?? [])], filesTouched: [], commands: [], todos: [], exchanges: [] }
  if (monitor.title) facts.title = monitor.title
  for (const m of messages) {
    if (m.kind === 'tool') {
      if (m.detail?.startsWith('$ ')) facts.commands.push(m.detail.slice(2))
      else if (m.detail && /^(Edited|Wrote|Created|Modified) /.test(m.title)) facts.filesTouched.push(m.detail)
      continue
    }
    if (!m.text.trim()) continue
    if (m.kind === 'user' && !facts.goal) facts.goal = m.text
    facts.exchanges.push({ role: m.kind, text: m.text })
  }
  for (const t of monitor.toolCalls ?? []) if (t.kind === 'edit' && t.detail && !facts.filesTouched.includes(t.detail)) facts.filesTouched.push(t.detail)
  return facts
}

/**
 * The fixed prompt of "Ask the agent to summarize": the source agent writes the summary itself
 * (it spends a turn of its account). No tools, so it cannot change anything while summarizing.
 */
export const HANDOFF_SUMMARY_PROMPT = [
  'Another coding agent is taking over this session. Without using any tools, write a hand-off summary of this conversation for it, in Markdown, with exactly these sections:',
  '## Goal — what the user wants, in one or two sentences.',
  '## Current state — what is done and what is not, as of now.',
  '## Decisions — choices made and why (libraries, approaches, things ruled out).',
  '## Files touched — paths, one line each on what changed.',
  '## Commands — the commands that matter to rebuild, test or run it.',
  '## Open TODOs — what is left, in order.',
  '## Next step — the very next thing to do.',
  'Reply with the summary only, no preamble. Keep it under 800 words.'
].join('\n')

/**
 * The agents a session can be handed off to, in the profile's order: agents with the app mode
 * (the brief is drafted in the chat), not the session's own agent and account. A Claude session
 * is not offered the other Claude accounts here: moving to them keeps the whole conversation
 * (see `failoverTargets`), which a hand-off cannot.
 */
export function handoffTargets(
  profile: Pick<Profile, 'preferredAgents'> | null | undefined,
  candidates: readonly EffectiveAgent[],
  source: { agentId: string; accountId: string | null; family: string }
): EffectiveAgent[] {
  const sourceKey = source.accountId ? `${source.agentId}:${source.accountId}` : source.agentId
  const usable = candidates.filter((e) => {
    if (!e.agent.capabilities.appMode || e.key === sourceKey) return false
    return !(source.family === 'claude' && accountAgentId(e.agent) === 'claude')
  })
  return orderAgents(profile?.preferredAgents, usable)
}
