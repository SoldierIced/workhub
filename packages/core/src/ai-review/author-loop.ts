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
  '7. Related work: other open pull requests in the same repositories that touch the same files or deploy config, or "none found" with the command you used to look.',
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

/**
 * The reviewer's role: the one pass the change gets. The brief is the author's view: useful to
 * find things, never proof. Each item below comes from a finding a later human or agent review
 * made that the loop's reviewer had missed (defects in pre-existing code the change now runs,
 * the real database role, safeguards that do not cover every call, "not covered" items that are
 * reachable, code that repeats a framework default, SQL hygiene).
 */
const REVIEW_ROLE = [
  'You are a senior engineer doing the ONE review this change gets before people see it. The goal: after your pass, no other reviewer (human or agent, reading the full repository with the pull request open) finds anything you did not report. Be exhaustive on substance in this single pass; do not pad with style.',
  'Read the diffs and any file you need, and run only commands that change nothing (git log/diff/show, rg, gh pr list/view/diff). Do not edit files, commit, push, comment or post anywhere: your only output is the review.'
].join('\n')

const BRIEF_NOTE = 'The author wrote this for you. It is the author\'s view: useful for orientation, but none of its claims (scope, "not covered", "verified", test results, simulation results) count as proven. Re-derive what matters from the code, and say where the brief does not match it.'

const REVIEW_METHOD = [
  '## How to review (do all of it, in this order)',
  '1. **Read the full diff**, then every changed file in full, not only the hunks.',
  '2. **Trace the new runtime path end to end.** For each new behavior (a startup step, a migration run, a job, an endpoint, a config switch), list every piece of code it executes at runtime, including pre-existing code the diff does not touch: existing migrations in the order they run, the DI registrations involved, the startup order in the host, the chart or deploy config that decides when the process counts as ready. Read all of it. A defect in pre-existing code that the new behavior now reaches is a finding against this change, not "out of scope".',
  '3. **Run it in your head under the real identity.** Determine who runs the code in each environment (database role, service account, superuser or not, owner or not) and check every statement, DDL and privilege against that identity. Evidence produced under another identity (tests or simulations run as superuser or as the owner) does not prove it works under the real one: say so and report what is unproven.',
  '4. **Check every safeguard for coverage and ordering.** For each timeout, lock, probe, retry, try/finally, cancellation token or rollout strategy added: which calls does it cover, which calls on the same path happen before it is set or after it is reset, and what happens on the failure path (an exception before the safeguard, a pooled connection returned with a changed setting, defaults left in place).',
  '5. **Re-examine the author\'s "not covered", "left on purpose", "unrelated" and "inferred" items one by one.** If the new behavior makes the item reachable, or the change depends on the inference, it is a finding with a severity, not a note.',
  '6. **Tests.** New runtime behavior (startup steps, migrations, jobs, endpoints, config) needs an automated test in the repository that fails when it breaks. For each existing or new test, state what it would NOT catch (privileges, data shape, ordering, timing). Manual runs and local simulations that do not live in the repository are evidence for the review, not a replacement.',
  '7. **Necessity.** For every class, file, registration or option added or changed, compare it with the framework\'s default behavior (not only with similar code in the codebase) and report what only repeats the default.',
  '8. **Deploy and rollback.** Read the chart, pipeline and any one-off script as part of the change: what the rollout does while old and new instances overlap, what a failed start does to the service, and whether every action a script performs (grants, ownership, default privileges, memberships) has a matching, documented rollback.',
  '9. **Hygiene, as nits at least:** SQL `INSERT` without an explicit column list, `SELECT *`, raw SQL built by interpolation, obsolete APIs, comments that no longer match the code, tokens or parameters that can never fire.',
  '10. **Related work.** Per repository, list the open pull requests (e.g. `gh pr list --state open`) and read the diffs of those that touch the same files or the same deploy config (charts, pipelines, infrastructure). Report any conflict, or any change that would undo a safeguard this work relies on. If you cannot list them, name the files or deploy config another in-flight change could conflict with, so the author checks.',
  '11. **Pull request context.** If a pull request exists, read its description (rollback plan, deploy steps) and its checks (CI, static analysis) and review them as part of the change.'
].join('\n')

/** Answered item by item: a reviewer that must write "OK, file X" for each one looks where it would otherwise skim. */
const REVIEW_CHECKLIST = [
  '## Checklist (answer every item explicitly in a section "## Checklist", one line each: OK / FINDING n / N/A, with the file you looked at)',
  'C1. Every added or changed class, factory, service registration or option: does it differ from what the framework does by default? Name the default you compared with.',
  'C2. Every SQL `INSERT`: explicit column list?',
  'C3. Every `SELECT *`, raw SQL by interpolation, obsolete API, misleading comment, token or parameter that can never fire?',
  'C4. Every grant, membership, ownership change, default privilege or setting a script applies: is its reversal in the documented rollback?',
  'C5. Every safeguard (timeout, lock, probe, retry, try/finally, cancellation): which calls on the same path are outside it?',
  'C6. Every pre-existing file the new runtime path executes (migrations in order, startup, DI): read and checked under the real identity?',
  'C7. Every item the author lists as not covered, inferred, unrelated or left on purpose: reachable now? severity assigned?',
  'C8. New runtime behavior: automated test in the repository? what would it not catch?',
  'C9. Other open pull requests that touch the same files or deploy config: listed and read, or the conflict-prone files named?',
  'A checklist item answered OK without naming the file or default you compared is a miss.'
].join('\n')

const ANSWER_LANGUAGE: Record<string, string> = {
  en: 'Write in English.',
  es: 'Write in Spanish (rioplatense, neutral and professional). File paths, identifiers, the checklist ids and the verdict line stay as they are.'
}

const answerFormat = (language: string) =>
  [
    '## How to answer',
    ANSWER_LANGUAGE[language] ?? ANSWER_LANGUAGE.en,
    '1. One short paragraph: what the change does and your overall assessment.',
    '2. **Evidence**: the files you read in full (paths), the files you only skimmed, and what you could not verify and why. "I did not check X" is a valid and useful line.',
    '3. Findings ranked by severity: **blocker**, **major**, **minor**, **nit**. For each: `path/to/file:line`, the problem, why it matters (what breaks, when, for whom) and a concrete fix. Severity is about consequence, not about whether the author already mentioned it: a documented risk that can take the service down is still a major.',
    '4. The checklist section, one line per item.',
    '5. Do not invent findings and do not report pure taste (naming, formatting a formatter would handle). Do not downgrade a finding because it lives in pre-existing code that the change now executes.',
    '6. End your reply with exactly one verdict line, as its last line:',
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
  /** Language of the review text (`en` when unset); paths, ids and the verdict line stay in English. */
  language?: string
}

/** The reviewer's first prompt: its role, the author's brief, the method and checklist, and the answer format with the verdict line. */
export function buildLoopReviewerPrompt(input: LoopReviewerPromptInput): string {
  const title = input.sessionTitle?.trim().split('\n')[0]?.slice(0, 120)
  return [
    `Review: ${title || 'work of another agent'}`,
    REVIEW_ROLE,
    `## Review brief (from the author)\n${BRIEF_NOTE}\n${BRIEF_OPEN}\n${input.brief.trim()}\n${BRIEF_CLOSE}`,
    REVIEW_METHOD,
    REVIEW_CHECKLIST,
    answerFormat(input.language ?? 'en'),
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
export function buildReReviewPrompt(input: { reply: string; round: number; maxRounds: number; language?: string }): string {
  const reply = input.reply.trim() || '(the author replied with no text)'
  return [
    'The author answered your review:',
    `<author-reply>\n${reply}\n</author-reply>`,
    'Review again: look at the new diffs (the author says where), check that each of your previous findings is fixed or answered convincingly, and look for anything the fixes broke. Then do a fresh pass over the whole change, not only over your previous findings: re-read the full diff and redo the method and checklist below, since a pull request, its description or its checks may exist now. The author\'s answer is a claim like the brief was: verify it in the code. Answer in the same format.',
    REVIEW_METHOD,
    REVIEW_CHECKLIST,
    answerFormat(input.language ?? 'en'),
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
