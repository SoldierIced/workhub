/**
 * The chat's Listen button: what an agent message becomes before the voice reads it. A short
 * message is read as it is (cleaned of Markdown); a long one is first summarized by a cheap model
 * into a few spoken sentences. Pure on purpose: the renderer decides with these, main builds the
 * model's prompt with them.
 */
import { speechText } from './text'

/** A message whose speakable text is shorter than this is read directly, with no model call. */
export const LISTEN_DIRECT_MAX = 400
/** Longest part of a message handed to the summarizing model; the rest is cut with a note. */
export const LISTEN_INPUT_MAX = 12_000
/** When the summary fails, the cleaned message is read up to this length instead. */
export const LISTEN_FALLBACK_MAX = 1_500

export type ListenPlan =
  /** Read this text now: the message is short. */
  | { kind: 'direct'; text: string }
  /** Ask the model for a spoken summary first. */
  | { kind: 'summarize' }
  /** Nothing to read (an empty message). */
  | { kind: 'empty' }

/**
 * How a message is read: directly when its speakable text is short, else through a summary. A
 * message that is only code (nothing speakable left) is summarized, so the listener hears what the
 * code is about.
 */
export function listenPlan(markdown: string): ListenPlan {
  if (!markdown.trim()) return { kind: 'empty' }
  const text = speechText(markdown)
  if (text && text.length < LISTEN_DIRECT_MAX) return { kind: 'direct', text }
  return { kind: 'summarize' }
}

/** Whether a message needs the model before it can be read. */
export const needsSummary = (markdown: string): boolean => listenPlan(markdown).kind === 'summarize'

/**
 * `markdown` up to `max` characters for the model, cut at a line break or a space near the limit
 * when there is one; `cut` is how many characters were left out (0: the whole message).
 */
export function truncateForSummary(markdown: string, max: number = LISTEN_INPUT_MAX): { text: string; cut: number } {
  if (markdown.length <= max) return { text: markdown, cut: 0 }
  let end = max
  // Never split a surrogate pair (an emoji) in half.
  if (/[\uD800-\uDBFF]/.test(markdown[end - 1] ?? '')) end -= 1
  const head = markdown.slice(0, end)
  const floor = Math.floor(end * 0.9)
  const newline = head.lastIndexOf('\n')
  const space = head.lastIndexOf(' ')
  const at = newline >= floor ? newline : space >= floor ? space : end
  const text = head.slice(0, at).trimEnd()
  return { text, cut: markdown.length - text.length }
}

/** The system prompt of the summarizing query: spoken prose only, in the message's language. */
export const LISTEN_SYSTEM_PROMPT = [
  'You rewrite a message from a coding agent so it can be listened to instead of read.',
  'Answer with the spoken summary only: plain prose of two to six short sentences.',
  'No Markdown, no lists, no headings, no code, no URLs, no file paths spelled out, no emoji.',
  'Name files, commands or code only in words when they matter, and keep numbers that matter.',
  'Write in the same language as the message. Do not add greetings, opinions or anything the message does not say.'
].join(' ')

/** The user prompt of the summarizing query: the message, cut to `max` characters with a note when longer. */
export function listenPrompt(markdown: string, max: number = LISTEN_INPUT_MAX): string {
  const { text, cut } = truncateForSummary(markdown, max)
  const note = cut > 0 ? `\n\n[The message was cut here: ${cut} more characters were left out. Summarize what is above.]` : ''
  return `Summarize this message for listening.\n\n<message>\n${text}${note}\n</message>`
}

/** The model's answer as speech: any Markdown it still wrote is cleaned the way a reply is. */
export const spokenSummary = (answer: string): string => speechText(answer)

/** What is read when the summary failed: the cleaned message, cut short. */
export const fallbackSpeech = (markdown: string): string => speechText(markdown, LISTEN_FALLBACK_MAX)

/** What a summary request answers (main → renderer). */
export type ListenSummaryResult =
  | { ok: true; summary: string; costUsd?: number }
  | { ok: false; failure: 'timeout' | 'rateLimited' | 'cancelled' | 'noAccount' | 'failed'; error: string; costUsd?: number }
