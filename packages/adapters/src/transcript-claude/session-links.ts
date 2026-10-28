/**
 * The pull requests, tickets and branches a Claude Code conversation acted on, from its tool calls
 * and their results: Jira calls that create or change a ticket, `gh pr` commands on one PR, and
 * git commands that create, check out, commit on or push a branch. Shared by the main conversation
 * and its subagents. What a tool only read or listed (a search, `gh pr list`, a file) counts for nothing.
 */
import type { SessionBranch, SessionPullRequestLink } from '@workhub/core'
import { isJiraTool, isJiraWrite, jiraTargetKeys, ticketKeys } from '../shared/claude-tools'
import { commandActions, printedBranches, printedPullRequestUrls, type CommandActions } from '../shared/shell-actions'

const LINKED_LIMIT = 20
const LINK_LIMIT = 100
const BRANCH_LIMIT = 50

/** Moves the key to the front of a short list (most recent first). */
function noteFirst(list: string[], key: string): void {
  const i = list.indexOf(key)
  if (i >= 0) list.splice(i, 1)
  list.unshift(key)
  if (list.length > LINKED_LIMIT) list.length = LINKED_LIMIT
}

const RANK = { acted: 0, user: 1, reply: 2 } as const

/** Adds a PR link once, oldest first; seen again from a stronger source (acting on it), it takes that source. */
export function noteLink(links: SessionPullRequestLink[], link: SessionPullRequestLink): void {
  const same = links.find((l) => (link.url ? l.url === link.url : !l.url && l.number === link.number && l.repo === link.repo && l.folder === link.folder))
  if (same) {
    if (RANK[link.source] < RANK[same.source]) same.source = link.source
    return
  }
  links.push(link)
  if (links.length > LINK_LIMIT) links.splice(0, links.length - LINK_LIMIT)
}

/** Adds a branch, most recent last; a branch named again moves to the end, and stays pushed once pushed. */
export function noteBranch(branches: SessionBranch[], branch: SessionBranch): void {
  const i = branches.findIndex((b) => b.name === branch.name && b.folder === branch.folder)
  const pushed = branch.pushed || (i >= 0 && branches[i]!.pushed)
  const repo = branch.repo ?? (i >= 0 ? branches[i]!.repo : undefined)
  if (i >= 0) branches.splice(i, 1)
  const out: SessionBranch = {}
  if (branch.name) out.name = branch.name
  if (branch.folder) out.folder = branch.folder
  if (repo) out.repo = repo
  if (pushed) out.pushed = true
  branches.push(out)
  if (branches.length > BRANCH_LIMIT) branches.splice(0, branches.length - BRANCH_LIMIT)
}

type Pending = { kind: 'jira'; create: boolean } | { kind: 'shell'; acts: CommandActions }

export class SessionLinks {
  /** The PRs the conversation acted on, oldest first. */
  readonly prs: SessionPullRequestLink[] = []
  readonly branches: SessionBranch[] = []
  /** Tickets created, then the ones changed (edit, transition, comment, link); most recent first. */
  private readonly created: string[] = []
  private readonly changed: string[] = []
  private readonly pending = new Map<string, Pending>()

  /**
   * @param reads Whether a PR it only read (`gh pr view`) counts. A subagent's reads are research
   * for the session (a review of many PRs), so only what it changed counts.
   */
  constructor(
    private readonly prefixes: readonly string[] | undefined,
    private readonly home: string,
    private readonly reads = true
  ) {}

  /** A tool call: what it acts on is known when its result says it worked. */
  call(callId: string, tool: string, input: Record<string, unknown>, cwd: string | undefined): void {
    if (isJiraTool(tool)) {
      const write = isJiraWrite(tool)
      if (!write) return
      for (const key of ticketKeys(jiraTargetKeys(input), this.prefixes)) noteFirst(this.changed, key)
      if (write === 'create') this.pending.set(callId, { kind: 'jira', create: true })
      return
    }
    if (tool === 'Bash' && typeof input['command'] === 'string') {
      const acts = commandActions(input['command'], cwd, this.home)
      if (acts.prs.length || acts.branches.length || acts.prOutput !== 'none') this.pending.set(callId, { kind: 'shell', acts })
    }
  }

  /** A tool call's result: a failed command acted on nothing. */
  result(callId: string, text: string, failed: boolean): void {
    const call = this.pending.get(callId)
    if (!call) return
    this.pending.delete(callId)
    if (failed) return
    if (call.kind === 'jira') {
      // The first key of a create's result is the ticket it made (a parent named later is not).
      const made = ticketKeys(text, this.prefixes)[0]
      if (made) noteFirst(this.created, made)
      return
    }
    const { acts } = call
    const printed = acts.prOutput === 'none' ? [] : printedPullRequestUrls(text)
    for (const pr of acts.prs) {
      if (!pr.changes && !this.reads) continue
      // `gh pr view 12` names no repository; its output may.
      const url = pr.url ?? printed.find((u) => u.endsWith(`/pull/${pr.number}`))
      noteLink(this.prs, url ? { source: 'acted', url } : { source: 'acted', number: pr.number, ...(pr.folder ? { folder: pr.folder } : {}) })
    }
    if (acts.prOutput === 'any' && (acts.outputChanges || this.reads)) for (const url of printed) noteLink(this.prs, { source: 'acted', url })
    if (acts.branches.length) this.noteBranches(acts, acts.readsGitOutput ? printedBranches(text) : [])
  }

  /** Created first, then changed; most recent first. */
  linkedTickets(): string[] {
    return [...new Set([...this.created, ...this.changed])]
  }

  /** A commit or push that did not name its branch takes the one git printed, in order. */
  private noteBranches(acts: CommandActions, printed: ReturnType<typeof printedBranches>): void {
    const commits = printed.filter((p) => !p.pushed)
    const pushes = printed.filter((p) => p.pushed)
    for (const b of acts.branches) {
      if (b.name) {
        const repo = b.pushed ? pushes.find((p) => p.name === b.name)?.repo : undefined
        noteBranch(this.branches, { ...b, ...(repo ? { repo } : {}) })
        continue
      }
      const seen = b.pushed ? pushes.shift() : commits.shift()
      noteBranch(this.branches, seen ? { name: seen.name, folder: b.folder, repo: seen.repo, pushed: b.pushed } : b)
    }
  }
}
