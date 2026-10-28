/**
 * "Review with another agent": a one-off review of something a session worked on, by an agent the
 * user picks. The target can be any repository the session touched (a session in a folder of
 * repositories included), and one of: its uncommitted changes, its branch against the base, a pull
 * request (open, merged or closed) or a commit range. The reviewer gets one complete prompt and
 * runs as a session of its own; nothing is sent back to the dev session.
 */
import type { EffectiveAgent } from '../usecases/effective-agents'

export const REVIEW_TARGET_KINDS = ['uncommitted', 'branch', 'pr', 'commits'] as const
export type ReviewTargetKind = (typeof REVIEW_TARGET_KINDS)[number]

/** What the user picked in the dialog. `repo` is a repository root from the offered list (or one typed by hand). */
export type ReviewTargetRequest =
  | { kind: 'uncommitted'; repo: string }
  | { kind: 'branch'; repo: string; base?: string }
  /** `pr`: a number (`123`, `#123`) or a pull request URL; `repo` gives a number its repository. */
  | { kind: 'pr'; repo?: string; pr: string }
  /** `range`: `<from>..<to>`, or one commit (reviewed against its parent). */
  | { kind: 'commits'; repo: string; range: string }

/** Why a target could not be resolved; the renderer turns each into an actionable message. */
export type ReviewTargetError =
  | 'noRepo'
  | 'notRepo'
  | 'noHead'
  | 'noChanges'
  | 'noBase'
  | 'noCommits'
  | 'badRange'
  | 'unknownCommit'
  | 'badPr'
  | 'prNeedsRepo'
  | 'prNoRemote'
  | 'prNotGitHub'
  | 'ghMissing'
  | 'ghSignedOut'
  | 'prNotFound'
  | 'ghFailed'

/** `gh`'s state for the dialog: the pull request option needs `ready`. */
export type GhState = 'ready' | 'missing' | 'signedOut'

/** A repository the dialog offers. */
export interface ReviewRepoOption {
  root: string
  name: string
  branch: string | null
  /** The session worked in it (its monitor's touched repositories). */
  touched: boolean
  /** Paths with uncommitted changes. */
  dirtyFiles: number
}

/** A pull request number or URL as typed: `{ number }`, plus the URL when one was given. */
export function parsePullRequestInput(text: string): { number: number; url?: string } | null {
  const t = text.trim()
  const n = /^#?(\d{1,9})$/.exec(t)
  if (n) return { number: Number(n[1]) }
  // GitHub (`/pull/12`) and GitLab (`/-/merge_requests/12`) URLs; only GitHub is read today.
  const u = /^https?:\/\/[^\s/]+\/[^\s]+?\/(?:pull|-\/merge_requests)\/(\d{1,9})(?:[/?#][^\s]*)?$/i.exec(t)
  if (u) return { number: Number(u[1]), url: t.replace(/[?#].*$/, '').replace(/\/(?:files|commits|checks)\/?$/, '').replace(/\/$/, '') }
  return null
}

/** Revision names a user may type: no option-looking or shell-looking text reaches git. */
const REV = /^[A-Za-z0-9][A-Za-z0-9._/@{}~^-]{0,199}$/

/** `a..b` (or `a...b`, read as `a..b`) or a single revision; null when it does not look like one. */
export function parseCommitRange(text: string): { from?: string; to: string } | null {
  const t = text.trim()
  const parts = t.split(/\.{2,3}/)
  if (parts.length === 1) return REV.test(t) ? { to: t } : null
  if (parts.length !== 2) return null
  const [from, to] = parts.map((p) => p.trim()) as [string, string]
  if (!REV.test(from) || !REV.test(to)) return null
  return { from, to }
}

/**
 * The default reviewer: an installed chat agent of another kind than the session's own (a Claude
 * session is reviewed by Kiro or Codex, say), in the profile's preferred order; else any installed
 * one. `installed` maps agent ids to whether their executable was found (absent: assumed installed).
 */
export function defaultReviewer(
  agents: readonly EffectiveAgent[],
  sessionAgentId: string,
  installed: Readonly<Record<string, boolean>> = {},
  preferred: readonly string[] = []
): EffectiveAgent | undefined {
  const usable = agents.filter((a) => a.agent.capabilities.appMode && a.agent.adapter !== 'terminal' && installed[a.agent.id] !== false)
  const ordered = [...preferred.map((k) => usable.find((a) => a.key === k)).filter((a): a is EffectiveAgent => a !== undefined), ...usable]
  return ordered.find((a) => a.agent.id !== sessionAgentId) ?? ordered[0]
}

/** A target resolved to what the reviewer reads. */
export interface ResolvedReviewTarget {
  kind: ReviewTargetKind
  /** Empty when the reviewer does not run in a checkout of it (a pull request of another repository). */
  repoRoot: string
  repoName: string
  /** One line: "uncommitted changes on `feat/x`", "commits a1b2c3..d4e5f6"… */
  description: string
  /** `<short sha> <subject>`, oldest first. */
  commits: string[]
  diffStat: string
  diff: string
  /** Untracked files (uncommitted target): not in the diff, the reviewer reads them from the folder. */
  untracked?: string[]
  pr?: { number: number; url: string; title: string; body: string; state: string; baseRefName?: string; headRefName?: string; mergedAt?: string }
}

export interface TargetReviewPromptInput {
  target: ResolvedReviewTarget
  sessionTitle?: string
  /** The session's first request, as its goal. */
  goal?: string
  ticket?: string
  /** The reviewer runs inside the target's repository (false: a PR read from another folder). */
  inRepo: boolean
  /** Diff size cut, in characters. */
  maxDiffChars: number
}

const GOAL_CHARS = 2_000
const BODY_CHARS = 6_000

const clip = (text: string, max: number) => {
  const t = text.trim()
  return t.length <= max ? t : `${t.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

/** A fence that the text cannot close. */
function fenced(text: string, lang = ''): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length))
  const fence = '`'.repeat(longest + 1)
  return `${fence}${lang}\n${text}\n${fence}`
}

/** The diff cut at `maxChars` on a line boundary. */
export function clipDiff(diff: string, maxChars: number): { text: string; truncated: boolean; total: number } {
  if (diff.length <= maxChars) return { text: diff, truncated: false, total: diff.length }
  const cut = diff.lastIndexOf('\n', maxChars)
  return { text: diff.slice(0, cut > 0 ? cut : maxChars), truncated: true, total: diff.length }
}

/** The one prompt the reviewer gets: context, the change, and how to answer. */
export function buildTargetReviewPrompt(input: TargetReviewPromptInput): string {
  const { target } = input
  const out: string[] = []
  // The first line names the reviewer session in the sidebar.
  out.push(
    `Review: ${target.repoName} · ${target.description}`,
    '',
    `You are reviewing code changes as a senior engineer. Review ${target.description} in the repository \`${target.repoName}\`.`,
    input.inRepo
      ? `Your working folder is that repository (\`${target.repoRoot}\`). Read any file you need for context, but do not edit files, commit, push or run commands that change anything: your only output is the review.`
      : 'Your working folder is not a checkout of this pull request: review from the diff below. Do not edit files, commit, push or run commands that change anything: your only output is the review.'
  )
  const context: string[] = []
  if (input.sessionTitle?.trim()) context.push(`- Session: ${clip(input.sessionTitle, 300)}`)
  if (input.ticket) context.push(`- Ticket: ${input.ticket}. Check the change against what the ticket asks for.`)
  context.push(`- Repository: \`${target.repoName}\`${target.repoRoot ? ` (\`${target.repoRoot}\`)` : ''}`)
  context.push(`- Target: ${target.description}`)
  out.push(`## Context\n${context.join('\n')}`)
  if (input.goal?.trim()) out.push(`## Goal of the work (the author's request)\n${fenced(clip(input.goal, GOAL_CHARS))}`)
  if (target.pr) {
    const pr = target.pr
    const lines = [`#${pr.number} ${pr.title}`, pr.url, `State: ${pr.state.toLowerCase()}${pr.mergedAt ? ` (merged ${pr.mergedAt})` : ''}`]
    if (pr.baseRefName && pr.headRefName) lines.push(`Branches: \`${pr.headRefName}\` into \`${pr.baseRefName}\``)
    out.push(`## Pull request\n${lines.join('\n')}`)
    out.push(`### Description\n${pr.body.trim() ? fenced(clip(pr.body, BODY_CHARS), 'markdown') : '(no description)'}`)
  }
  if (target.commits.length) out.push(`## Commits\n${target.commits.map((c) => `- ${c}`).join('\n')}`)
  if (target.diffStat.trim()) out.push(`## Files changed\n${fenced(target.diffStat.trim())}`)
  if (target.untracked?.length) out.push(`## New files not yet tracked by git (read them from the folder)\n${target.untracked.map((f) => `- ${f}`).join('\n')}`)
  const diff = clipDiff(target.diff, input.maxDiffChars)
  if (!diff.text.trim()) out.push('## Diff\n(empty: there are no changes in tracked files)')
  else {
    out.push(`## Diff\n${fenced(diff.text, 'diff')}`)
    if (diff.truncated)
      out.push(
        `Note: the diff was truncated at ${diff.text.length.toLocaleString('en-US')} of ${diff.total.toLocaleString('en-US')} characters. ${input.inRepo ? 'Read the remaining changed files (see "Files changed") from the folder before concluding.' : 'Say in the summary which files you could not review.'}`
      )
  }
  out.push(
    [
      '## How to review',
      '- Look for bugs, broken edge cases, security problems, data loss, concurrency issues, missing or wrong tests, and changes that do not do what the goal or ticket asks.',
      '- Follow the change end to end; read surrounding code before calling something wrong. Do not report style preferences as problems.',
      '',
      '## How to answer',
      '1. One short paragraph: what the change does and your overall verdict.',
      '2. Findings ranked by severity: **blocker**, **major**, **minor**, **nit**. For each: `path/to/file:line`, the problem, why it matters, and a concrete fix.',
      '3. If you find nothing worth changing, say so plainly. Do not invent findings.'
    ].join('\n')
  )
  return out.join('\n\n')
}
