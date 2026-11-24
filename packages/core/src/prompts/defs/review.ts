import type { PromptDefinition } from '../types'

/** Today's brief request: the author is asked for a review brief between markers. */
const BRIEF_ASK = [
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
  '## Checklist (answer every item explicitly in a section "## Checklist", one line each: OK / FINDING F<n> / N/A, with the file you looked at)',
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

const LOOP_ROLE = [
  'Review: {sessionTitle}',
  '',
  'You are a senior engineer doing the ONE review this change gets before people see it. The goal: after your pass, no other reviewer (human or agent, reading the full repository with the pull request open) finds anything you did not report. Be exhaustive on substance in this single pass; do not pad with style.',
  '{brief}'
].join('\n')

const FIX_HEAD = 'Review round {round} of {maxRounds} by {reviewer}: changes requested.'

/** The editable prompts of the AI review (author loop and review before a pull request). */
export const REVIEW_PROMPTS = {
  'review.briefAsk': { area: 'review', placeholders: [], defaultText: BRIEF_ASK },
  'review.method': { area: 'review', placeholders: [], defaultText: REVIEW_METHOD },
  'review.checklist': { area: 'review', placeholders: [], defaultText: REVIEW_CHECKLIST },
  'review.loopRole': { area: 'review', placeholders: ['sessionTitle', 'maxRounds', 'brief'], slots: ['brief'], defaultText: LOOP_ROLE },
  'review.loopAuthorFix': {
    area: 'review',
    placeholders: ['round', 'maxRounds', 'reviewer'],
    defaultText: `${FIX_HEAD}\n\nThe reviewer's findings are below. Fix the ones you agree with; for any you disagree with, say why. Then reply with what you changed (files, commits, and how to see the new diff) and what you left as is: your reply goes back to the reviewer for another review.`
  },
  'review.loopAuthorFixSelected': {
    area: 'review',
    placeholders: ['round', 'maxRounds', 'reviewer'],
    defaultText: `${FIX_HEAD}\n\nFix the findings below that you agree with; for any you disagree with, say why. Follow the user's note when there is one. Then reply with what you changed (files, commits, and how to see the new diff) and what you left as is: your reply goes back to the reviewer for another review.`
  },
  'review.loopAuthorApproved': {
    area: 'review',
    placeholders: ['round', 'maxRounds', 'reviewer'],
    defaultText:
      'Review round {round} of {maxRounds} by {reviewer}: approved. The loop is over and nothing more goes back to the reviewer.\n\nThe final review is below. Apply any remaining nits you agree with, then reply with a short summary of the review and of what, if anything, you changed.'
  },
  'review.loopAuthorOutOfRounds': {
    area: 'review',
    placeholders: ['round', 'maxRounds', 'reviewer'],
    defaultText:
      "Review round {round} of {maxRounds} by {reviewer}: changes requested, and that was the last round. The loop is over and nothing more goes back to the reviewer.\n\nThe reviewer's last findings are below. Fix the ones you agree with, say why for any you disagree with, and reply with a short summary of what you changed and what is still open."
  },
  'review.loopReReview': {
    area: 'review',
    placeholders: ['round', 'maxRounds'],
    defaultText:
      "Review again: look at the new diffs (the author says where), check that each of your previous findings is fixed or answered convincingly, and look for anything the fixes broke. Then do a fresh pass over the whole change, not only over your previous findings: re-read the full diff and redo the method and checklist below, since a pull request, its description or its checks may exist now. The author's answer is a claim like the brief was: verify it in the code. Answer in the same format."
  },
  'review.prRound': {
    area: 'review',
    placeholders: ['branch', 'base', 'round', 'maxRounds'],
    defaultText:
      'You are the code reviewer of branch `{branch}`, which will be opened as a pull request into `{base}`. This is review round {round} of at most {maxRounds}. The team wants ONE exhaustive pass: report everything you find now, so the author does not get a new batch of comments on every round. Be precise and concrete; do not pad the list.',
    defaultEs:
      'Eres el revisor de código de la rama `{branch}`, que se abrirá como pull request hacia `{base}`. Esta es la ronda de revisión {round} de un máximo de {maxRounds}. El equipo quiere UNA pasada exhaustiva: informa ahora todo lo que encuentres, para que el autor no reciba una tanda nueva de comentarios en cada ronda. Sé preciso y concreto; no rellenes la lista.'
  },
  'review.prRoundDelta': {
    area: 'review',
    placeholders: ['round', 'fromSha'],
    defaultText:
      'Round {round}: the author pushed new commits after your last review. Review the delta since `{fromSha}` (below), re-check the whole branch where the delta touches it, and verify each previous finding listed below: say whether it is fixed or still open. Report only genuinely new issues as new findings.',
    defaultEs:
      'Ronda {round}: el autor subió commits nuevos después de tu última revisión. Revisa el delta desde `{fromSha}` (abajo), vuelve a mirar la rama entera donde el delta la toca y verifica cada hallazgo anterior listado abajo: indica si está corregido o sigue abierto. Informa como hallazgos nuevos solo problemas realmente nuevos.'
  },
  'review.prDevMessage': {
    area: 'review',
    placeholders: [],
    defaultText: 'Fix them, run the tests, and commit (do not open the pull request yet). The reviewer checks the new commits in the next round.',
    defaultEs: 'Corrígelos, ejecuta las pruebas y haz commit (no abras el pull request todavía). El revisor verifica los commits nuevos en la próxima ronda.'
  },
  'review.prOpinion': {
    area: 'review',
    placeholders: [],
    defaultText: 'A note from the user about this review:',
    defaultEs: 'Una nota del usuario sobre esta revisión:'
  }
} satisfies Record<string, PromptDefinition>
