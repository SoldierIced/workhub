/**
 * "Review with another agent": the session's own agent (the author) writes a review brief for a
 * reviewer agent the user picks, and the two then run a correction loop. Workhub never picks a
 * repository or a diff itself: the author knows every repository, branch, commit and pull request
 * it touched. This file holds the texts Workhub sends and reads; the main process runs the loop.
 */
import { accountAgentId } from '../domain/agent'
import type { EffectiveAgent } from '../usecases/effective-agents'
import type { AiReviewSettings } from './types'

export const BRIEF_OPEN = '<review-brief>'
export const BRIEF_CLOSE = '</review-brief>'

/** Rounds of the loop when the profile sets none: reviewer verdicts before the loop stops. */
export const DEFAULT_LOOP_ROUNDS = 3

/** What the author is asked first: a self-contained brief for the reviewer, between markers. */
export const DEFAULT_REVIEW_BRIEF_PROMPT = [
  'Another agent is going to review the work done in this session. Write a complete, self-contained review brief for it: the reviewer has not seen this conversation and only gets what you write.',
  '',
  'The brief must cover:',
  '1. Goal: what was asked and why, with ticket keys and links when there are any.',
  '2. Every repository touched: its absolute path, the branch, the base branch, and whether the changes are committed, pushed or still uncommitted.',
  '3. Commits and pull requests: hashes or ranges, and pull request URLs.',
  '4. What changed and why, per repository: the main files and the decisions taken.',
  '5. How to see the diffs: the exact commands per repository, e.g. `git -C <path> diff <base>...<branch>`, `git -C <path> diff` for uncommitted work, `gh pr diff <url>`.',
  '6. What to check: risky areas, edge cases, the tests you ran and their results, and anything you are unsure about.',
  '',
  'Do not change anything while writing the brief. Put the whole brief between a line with <review-brief> and a line with </review-brief>, so Workhub can hand it to the reviewer.'
].join('\n')

/** The profile's brief prompt, or the default when it sets none. */
export function briefPromptOf(settings: Pick<AiReviewSettings, 'briefPrompt'>): string {
  return settings.briefPrompt.trim() ? settings.briefPrompt : DEFAULT_REVIEW_BRIEF_PROMPT
}

/**
 * The brief in the author's reply: the text inside the last `<review-brief>` block (up to the end
 * when it was never closed), else the whole reply. Null when there is nothing to send.
 */
export function extractReviewBrief(reply: string): string | null {
  const open = reply.lastIndexOf(BRIEF_OPEN)
  if (open >= 0) {
    const from = open + BRIEF_OPEN.length
    const close = reply.indexOf(BRIEF_CLOSE, from)
    const inside = (close >= 0 ? reply.slice(from, close) : reply.slice(from)).trim()
    if (inside) return inside
  }
  const whole = reply.replaceAll(BRIEF_OPEN, '').replaceAll(BRIEF_CLOSE, '').trim()
  return whole || null
}

export type ReviewVerdict = 'approved' | 'changesRequested'

/** The reviewer's verdict: the last `VERDICT:` line of its reply (bold or code marks allowed); null when there is none. */
export function parseReviewVerdict(reply: string): ReviewVerdict | null {
  const matches = [...reply.replace(/[*`]/g, '').matchAll(/\bVERDICT\s*:\s*(APPROVED|CHANGES[_ -]REQUESTED)\b/gi)]
  const last = matches.at(-1)?.[1]
  if (!last) return null
  return last.toUpperCase() === 'APPROVED' ? 'approved' : 'changesRequested'
}

/** What happens after a verdict: the loop ends approved, ends at its last round, or sends the findings to the author. */
export function afterVerdict(verdict: ReviewVerdict | null, round: number, maxRounds: number): 'approved' | 'maxRounds' | 'fixing' {
  if (verdict === 'approved') return 'approved'
  return round >= maxRounds ? 'maxRounds' : 'fixing'
}

const ANSWER_FORMAT = [
  '## How to answer',
  '1. One short paragraph: what the change does and your overall assessment.',
  '2. Findings ranked by severity: **blocker**, **major**, **minor**, **nit**. For each: `path/to/file:line`, the problem, why it matters and a concrete fix.',
  '3. Do not invent findings, and do not report style preferences as problems.',
  '4. End your reply with exactly one verdict line, as its last line:',
  '   - `VERDICT: APPROVED` when nothing must change before merging (nits are allowed);',
  '   - `VERDICT: CHANGES_REQUESTED` when at least one finding must be fixed.'
].join('\n')

const roundLine = (round: number, maxRounds: number) =>
  round >= maxRounds ? `This is round ${round} of ${maxRounds}, the last one: there is no re-review after it.` : `This is round ${round} of at most ${maxRounds}: your findings go to the author, who fixes them and answers, and you then review again.`

export interface LoopReviewerPromptInput {
  brief: string
  /** The reviewed session's name, for the first line (it names the reviewer session in the sidebar). */
  sessionTitle?: string
  maxRounds: number
}

/** The reviewer's first prompt: its role, the author's brief and the answer format with the verdict line. */
export function buildLoopReviewerPrompt(input: LoopReviewerPromptInput): string {
  const title = input.sessionTitle?.trim().split('\n')[0]?.slice(0, 120)
  return [
    `Review: ${title || 'work of another agent'}`,
    'You are a senior engineer reviewing another agent\'s work. The author wrote the brief below for you: it names the repositories, branches, commits and pull requests to review and how to see the diffs. Read the diffs and any file you need, but do not edit files, commit, push or run commands that change anything: your only output is the review.',
    `## Review brief (from the author)\n${BRIEF_OPEN}\n${input.brief.trim()}\n${BRIEF_CLOSE}`,
    ANSWER_FORMAT,
    roundLine(1, input.maxRounds)
  ].join('\n\n')
}

/** The reviewer's findings as the author gets them: fix, then answer for the re-review. */
export function buildAuthorFixPrompt(input: { review: string; reviewer: string; round: number; maxRounds: number }): string {
  return [
    `Review round ${input.round} of ${input.maxRounds} by ${input.reviewer}: changes requested.`,
    'The reviewer\'s findings are below. Fix the ones you agree with; for any you disagree with, say why. Then reply with what you changed (files, commits, and how to see the new diff) and what you left as is: your reply goes back to the reviewer for another review.',
    `<review>\n${input.review.trim()}\n</review>`
  ].join('\n\n')
}

/** The reviewer's last answer as the author gets it when the loop ends: approved, or out of rounds. */
export function buildAuthorFinalPrompt(input: { review: string; reviewer: string; outcome: 'approved' | 'maxRounds'; round: number; maxRounds: number }): string {
  const head =
    input.outcome === 'approved'
      ? `Review round ${input.round} of ${input.maxRounds} by ${input.reviewer}: approved. The loop is over and nothing more goes back to the reviewer.`
      : `Review round ${input.round} of ${input.maxRounds} by ${input.reviewer}: changes requested, and that was the last round. The loop is over and nothing more goes back to the reviewer.`
  const ask =
    input.outcome === 'approved'
      ? 'The final review is below. Apply any remaining nits you agree with, then reply with a short summary of the review and of what, if anything, you changed.'
      : 'The reviewer\'s last findings are below. Fix the ones you agree with, say why for any you disagree with, and reply with a short summary of what you changed and what is still open.'
  return [head, ask, `<review>\n${input.review.trim()}\n</review>`].join('\n\n')
}

/** The author's answer as the reviewer gets it: review again, same format, same verdict line. */
export function buildReReviewPrompt(input: { reply: string; round: number; maxRounds: number }): string {
  const reply = input.reply.trim() || '(the author replied with no text)'
  return [
    'The author answered your review:',
    `<author-reply>\n${reply}\n</author-reply>`,
    'Review again: look at the new diffs (the author says where), check that each of your previous findings is fixed or answered convincingly, and look for anything the fixes broke. Answer in the same format.',
    ANSWER_FORMAT,
    roundLine(input.round, input.maxRounds)
  ].join('\n\n')
}

/**
 * The default reviewer: an installed chat agent of another kind than the session's own (a Claude
 * session is reviewed by Kiro or Codex, say, never by Claude over ACP), in the profile's preferred
 * order; else any installed one. `installed` maps agent ids to whether their executable was found
 * (absent: assumed installed).
 */
export function defaultReviewer(
  agents: readonly EffectiveAgent[],
  sessionAgentId: string,
  installed: Readonly<Record<string, boolean>> = {},
  preferred: readonly string[] = []
): EffectiveAgent | undefined {
  const usable = agents.filter((a) => a.agent.capabilities.appMode && a.agent.adapter !== 'terminal' && installed[a.agent.id] !== false)
  const ordered = [...preferred.map((k) => usable.find((a) => a.key === k)).filter((a): a is EffectiveAgent => a !== undefined), ...usable]
  const own = agents.find((a) => a.agent.id === sessionAgentId)
  const family = own ? accountAgentId(own.agent) : sessionAgentId
  return ordered.find((a) => accountAgentId(a.agent) !== family) ?? ordered[0]
}
