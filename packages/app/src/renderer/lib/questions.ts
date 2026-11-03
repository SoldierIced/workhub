import type { AgentQuestion } from '@workhub/core'

/** What the user chose for one question: the picked option labels and their own words ("Other"). */
export interface QuestionPick {
  labels: string[]
  other: string
}

export const EMPTY_PICK: QuestionPick = { labels: [], other: '' }

/** Picks an option: one question with a single answer keeps only it (and drops "Other"); a multi-select toggles it. */
export function togglePick(pick: QuestionPick, label: string, multiSelect: boolean): QuestionPick {
  if (!multiSelect) return { labels: [label], other: '' }
  return { ...pick, labels: pick.labels.includes(label) ? pick.labels.filter((l) => l !== label) : [...pick.labels, label] }
}

/** Types into "Other": on a single-answer question the typed words replace the picked option. */
export function typeOther(pick: QuestionPick, text: string, multiSelect: boolean): QuestionPick {
  return multiSelect ? { ...pick, other: text } : { labels: text.trim() ? [] : pick.labels, other: text }
}

/** One question's answer as Claude Code reads it: the labels (comma-separated) and the user's words. */
export function answerOf(question: AgentQuestion, pick: QuestionPick): string {
  const labels = question.options.map((o) => o.label).filter((l) => pick.labels.includes(l))
  const other = pick.other.trim()
  return [...labels, ...(other ? [other] : [])].join(', ')
}

/** The answers to send (question text to answer), or null while a question has none. */
export function questionAnswers(questions: readonly AgentQuestion[], picks: readonly (QuestionPick | undefined)[]): Record<string, string> | null {
  const out: Record<string, string> = {}
  for (const [i, q] of questions.entries()) {
    const answer = answerOf(q, picks[i] ?? EMPTY_PICK)
    if (!answer) return null
    out[q.question] = answer
  }
  return out
}

/** The answers in one line, for the answered card and the history: "Color: Blue · Extras: Cream". */
export function answersSummary(questions: readonly AgentQuestion[], answers: Record<string, string>): string {
  return questions
    .filter((q) => answers[q.question])
    .map((q) => (questions.length > 1 ? `${q.header || q.question}: ${answers[q.question]}` : answers[q.question]!))
    .join(' · ')
}
