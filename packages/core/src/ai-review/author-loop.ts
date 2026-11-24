/**
 * "Review with another agent": the session's own agent (the author) writes a review brief for a
 * reviewer agent the user picks, and the two then run a correction loop. Workhub never picks a
 * repository or a diff itself: the author knows every repository, branch, commit and pull request
 * it touched. This file holds the texts Workhub sends and reads; the main process runs the loop.
 */
import { accountAgentId } from '../domain/agent'
import type { EffectiveAgent } from '../usecases/effective-agents'
import { fillPrompt, promptTemplate } from '../prompts/registry'
import { REVIEW_PROMPTS } from '../prompts/defs/review'
import type { PromptOverrides } from '../prompts/types'
import type { AiReviewSettings } from './types'

export const BRIEF_OPEN = '<review-brief>'
export const BRIEF_CLOSE = '</review-brief>'

/** Rounds of the loop when the profile sets none: reviewer verdicts before the loop stops. */
export const DEFAULT_LOOP_ROUNDS = 3

/** What the author is asked first: a self-contained brief for the reviewer, between markers. */
export const DEFAULT_REVIEW_BRIEF_PROMPT = REVIEW_PROMPTS['review.briefAsk'].defaultText

/** The profile's own brief prompt, else the app-wide text (Settings → Prompts), else the built-in default. */
export function briefPromptOf(settings: Pick<AiReviewSettings, 'briefPrompt'>, overrides?: PromptOverrides): string {
  return settings.briefPrompt.trim() ? settings.briefPrompt : promptTemplate(overrides, 'review.briefAsk')
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
/** The part of the role no text can drop: the reviewer only reads and writes its review. */
const READ_ONLY_ROLE = 'Read the diffs and any file you need, and run only commands that change nothing (git log/diff/show, rg, gh pr list/view/diff). Do not edit files, commit, push, comment or post anywhere: your only output is the review.'

const BRIEF_NOTE = 'The author wrote this for you. It is the author\'s view: useful for orientation, but none of its claims (scope, "not covered", "verified", test results, simulation results) count as proven. Re-derive what matters from the code, and say where the brief does not match it.'

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
    '3. Findings ranked by severity: **blocker**, **major**, **minor**, **nit**. Number them F1, F2, … and start each one on its own line as `F<n> [severity] path/to/file:line — the problem`, then why it matters (what breaks, when, for whom) and a concrete fix on the lines below it. Severity is about consequence, not about whether the author already mentioned it: a documented risk that can take the service down is still a major.',
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
export function buildLoopReviewerPrompt(input: LoopReviewerPromptInput, overrides?: PromptOverrides): string {
  const title = input.sessionTitle?.trim().split('\n')[0]?.slice(0, 120)
  // The read-only line and the untrusted brief block always travel together, wherever the text puts `{brief}`.
  const brief = `${READ_ONLY_ROLE}\n\n## Review brief (from the author)\n${BRIEF_NOTE}\n${BRIEF_OPEN}\n${input.brief.trim()}\n${BRIEF_CLOSE}`
  return [
    fillPrompt(promptTemplate(overrides, 'review.loopRole'), { sessionTitle: title || 'work of another agent', maxRounds: input.maxRounds, brief }),
    promptTemplate(overrides, 'review.method'),
    promptTemplate(overrides, 'review.checklist'),
    answerFormat(input.language ?? 'en'),
    roundLine(1, input.maxRounds)
  ].join('\n\n')
}

export const FINDING_SEVERITIES = ['blocker', 'major', 'minor', 'nit'] as const
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number]

/** One finding of a reviewer's answer, as `parseLoopFindings` reads it. */
export interface LoopFinding {
  /** `F1`, `F2`, … as the reviewer numbered it. */
  id: string
  severity?: FindingSeverity
  /** The finding's first line (file, line and problem), without its id and severity. */
  title: string
  /** The whole finding as the reviewer wrote it, first line included. */
  text: string
}

/** The longest finding text kept, and the most findings read from one answer. */
export const LOOP_FINDING_LIMITS = { text: 4000, count: 60 } as const

const FINDING_START = /^\s*(?:[-*+]\s+|\d+[.)]\s+|#{1,6}\s+)?[*_`]*(F\d{1,3})\b[*_`]*\s*[:.)\-–—]?\s*(.*)$/i
const SEVERITY_TAG = /^[[(*_`]*\s*(blocker|major|minor|nit)\s*[\])*_`]*\s*[:\-–—]?\s*/i
/** A section heading, a bare `Checklist` / `Evidence` label line, or the verdict: the findings are over. */
const ENDS_FINDINGS = /^\s*(#{1,6}\s|[*_]*(checklist|evidence|evidencia)[*_]*\s*:?\s*[*_]*\s*$|[*`]*VERDICT\s*:)/i

/**
 * The findings of a reviewer's answer, in its order: each starts on a line with its id (`F1
 * [major] src/a.ts:10 — …`, with list marks, bold or a heading allowed) and runs until the next
 * one, a heading, a bare checklist or evidence label, or the verdict line. When the answer tags any
 * finding with a severity, only tagged lines start findings: a re-review's status lines (`- F1:
 * fixed`) are not new findings and close the one before them. An id seen twice keeps its first
 * finding. Empty when the reviewer did not number its findings.
 */
export function parseLoopFindings(review: string): LoopFinding[] {
  const out: LoopFinding[] = []
  let current: { id: string; severity?: FindingSeverity; title: string; lines: string[] } | null = null
  const close = () => {
    if (current && !out.some((f) => f.id === current!.id) && out.length < LOOP_FINDING_LIMITS.count) {
      const text = current.lines.join('\n').trim().slice(0, LOOP_FINDING_LIMITS.text)
      out.push({ id: current.id, ...(current.severity ? { severity: current.severity } : {}), title: current.title.slice(0, 300), text })
    }
    current = null
  }
  const lines = review.split('\n')
  const tagged = (line: string) => {
    const m = FINDING_START.exec(line)
    return !!m && SEVERITY_TAG.test(m[2] ?? '')
  }
  const strict = lines.some(tagged)
  for (const line of lines) {
    const start = FINDING_START.exec(line)
    if (start && strict && !tagged(line)) {
      close()
      continue
    }
    if (start) {
      close()
      let rest = start[2] ?? ''
      const tag = SEVERITY_TAG.exec(rest)
      const severity = tag ? (tag[1]!.toLowerCase() as FindingSeverity) : FINDING_SEVERITIES.find((s) => new RegExp(`\\b${s}\\b`, 'i').test(rest.slice(0, 40)))
      if (tag) rest = rest.slice(tag[0].length)
      current = { id: start[1]!.toUpperCase(), ...(severity ? { severity } : {}), title: rest.replace(/[*_`]+/g, '').trim(), lines: [line] }
      continue
    }
    if (current && ENDS_FINDINGS.test(line)) close()
    else if (current) current.lines.push(line)
  }
  close()
  return out
}

/**
 * How the findings the user dropped are told to the reviewer on later rounds: by round and title,
 * since every round numbers its findings from F1 again. Dropping an unnumbered review drops it whole.
 */
export function setAsideItems(selection: FindingSelection, round: number): string[] {
  const keep = new Set(selection.keep)
  if (selection.findings.length === 0) return keep.size ? [] : [`Everything in your round ${round} review.`]
  return selection.findings.filter((f) => !keep.has(f.id)).map((f) => `Round ${round} ${f.id}: ${(f.title || f.text).slice(0, 200)}`)
}

/** What the user let through to the author: the findings kept (ids), and a note of their own. */
export interface FindingSelection {
  findings: readonly LoopFinding[]
  keep: readonly string[]
  note?: string
}

/** The part of the review the author gets after the user picked: the kept findings, the set-aside ids and the note. */
function selectedReview(selection: FindingSelection, review: string): string[] {
  const keep = new Set(selection.keep)
  const kept = selection.findings.filter((f) => keep.has(f.id))
  const dropped = selection.findings.filter((f) => !keep.has(f.id))
  const note = selection.note?.trim()
  // Unnumbered findings come as one item: keeping it sends the whole review.
  const body = selection.findings.length === 0 ? (keep.size > 0 ? review.trim() : '') : kept.map((f) => f.text).join('\n\n')
  return [
    'The user read the reviewer\'s findings before they reached you and chose which ones you get.',
    ...(body ? [`<review>\n${body}\n</review>`] : ['None of the findings was kept.']),
    ...(dropped.length ? [`The user set these findings aside: do not fix them. ${dropped.map((f) => `${f.id}${f.title ? ` (${f.title.slice(0, 120)})` : ''}`).join('; ')}.`] : []),
    ...(note ? [`<user-note>\n${note}\n</user-note>`] : [])
  ]
}

/** The reviewer's findings as the author gets them: fix, then answer for the re-review. */
export function buildAuthorFixPrompt(input: { review: string; reviewer: string; round: number; maxRounds: number; selection?: FindingSelection }, overrides?: PromptOverrides): string {
  const id = input.selection ? 'review.loopAuthorFixSelected' : 'review.loopAuthorFix'
  return [
    fillPrompt(promptTemplate(overrides, id), { round: input.round, maxRounds: input.maxRounds, reviewer: input.reviewer }),
    ...(input.selection ? selectedReview(input.selection, input.review) : [`<review>\n${input.review.trim()}\n</review>`])
  ].join('\n\n')
}

/** The reviewer's last answer as the author gets it when the loop ends: approved, or out of rounds. */
export function buildAuthorFinalPrompt(input: { review: string; reviewer: string; outcome: 'approved' | 'maxRounds'; round: number; maxRounds: number; selection?: FindingSelection }, overrides?: PromptOverrides): string {
  const id = input.outcome === 'approved' ? 'review.loopAuthorApproved' : 'review.loopAuthorOutOfRounds'
  const head = fillPrompt(promptTemplate(overrides, id), { round: input.round, maxRounds: input.maxRounds, reviewer: input.reviewer })
  return [head, ...(input.selection ? selectedReview(input.selection, input.review) : [`<review>\n${input.review.trim()}\n</review>`])].join('\n\n')
}

/** The author's answer as the reviewer gets it: review again, same format, same verdict line. */
export function buildReReviewPrompt(input: { reply: string; round: number; maxRounds: number; language?: string; setAside?: { items: readonly string[]; note?: string } }, overrides?: PromptOverrides): string {
  const reply = input.reply.trim() || '(the author replied with no text)'
  const items = input.setAside?.items ?? []
  const note = input.setAside?.note?.trim()
  return [
    'The author answered your review:',
    `<author-reply>\n${reply}\n</author-reply>`,
    ...(items.length ? [`The user set aside these findings of yours from earlier rounds, and the author was told not to fix them: do not raise them again unless the new changes make them worse. Number this round's findings from F1 again.\n${items.map((i) => `- ${i}`).join('\n')}`] : []),
    ...(note ? [`The user added a note for the author:\n<user-note>\n${note}\n</user-note>`] : []),
    fillPrompt(promptTemplate(overrides, 'review.loopReReview'), { round: input.round, maxRounds: input.maxRounds }),
    promptTemplate(overrides, 'review.method'),
    promptTemplate(overrides, 'review.checklist'),
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
