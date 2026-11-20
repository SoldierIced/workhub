/**
 * The chat's Listen button: reads one agent message aloud, summarized first by a cheap model when
 * it is long. It shares the window's one voice (readAloud.ts): starting a message stops whatever
 * was being read or summarized.
 */
import type { MessageKey } from '../i18n/translate'
import { useSyncExternalStore } from 'react'
import { fallbackIsCut, fallbackSpeech, listenPlan, type ListenSummaryResult } from '@workhub/core'
import { pauseSpeaking, resumeSpeaking, speak, stopSpeaking, useSpeech, type SpeakOptions } from './readAloud'

export type ListenPhase = 'idle' | 'summarizing' | 'playing' | 'paused'

/** The speech id of one chat message. */
export const listenId = (sessionId: string, itemId: number | string): string => `listen:${sessionId}:${itemId}`

/** What the button of message `id` shows, given what is being summarized and what the voice reads. */
export function listenPhase(id: string, summarizingId: string | null, speech: { id: string | null; paused: boolean }): ListenPhase {
  if (summarizingId === id) return 'summarizing'
  if (speech.id !== id) return 'idle'
  return speech.paused ? 'paused' : 'playing'
}

/** How a listen ended, for the caller's toast. */
export type ListenOutcome =
  | { kind: 'spoken'; summarized: boolean }
  /** The summary failed: the cleaned message, cut short, was read instead. */
  | { kind: 'fallback'; failure: Exclude<ListenSummaryResult, { ok: true }>['failure']; cut: boolean }
  /** Stopped, or replaced by another message, before anything was read. */
  | { kind: 'cancelled' }
  /** Nothing could be read (an empty message, or no voice on this system). */
  | { kind: 'silent' }

interface Pending {
  id: string
  requestId: string
}

let pending: Pending | null = null
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

function setPending(next: Pending | null): void {
  pending = next
  emit()
}

/** Stops a summary still running (main kills its query) and whatever the voice reads. */
export function stopListening(): void {
  if (pending) {
    window.hub.listen.cancel(pending.requestId)
    setPending(null)
  }
  stopSpeaking()
}

export interface ListenRequest {
  sessionId: string
  itemId: number | string
  markdown: string
  voice: Omit<SpeakOptions, 'id'>
}

/** Reads one agent message: directly when short, else its spoken summary; the cleaned message when the summary fails. */
export async function listen({ sessionId, itemId, markdown, voice }: ListenRequest): Promise<ListenOutcome> {
  const id = listenId(sessionId, itemId)
  stopListening()
  const plan = listenPlan(markdown)
  if (plan.kind === 'empty') return { kind: 'silent' }
  if (plan.kind === 'direct') return speak(plan.text, { id, ...voice }) ? { kind: 'spoken', summarized: false } : { kind: 'silent' }
  const requestId = crypto.randomUUID()
  setPending({ id, requestId })
  const result: ListenSummaryResult = await window.hub.listen
    .summarize(requestId, sessionId, markdown)
    .catch((err: unknown) => ({ ok: false, failure: 'failed', error: err instanceof Error ? err.message : String(err) }) as const)
  // Stopped or replaced while the model worked: say nothing.
  if (pending?.requestId !== requestId) return { kind: 'cancelled' }
  setPending(null)
  if (result.ok) return speak(result.summary, { id, ...voice }) ? { kind: 'spoken', summarized: true } : { kind: 'silent' }
  if (result.failure === 'cancelled') return { kind: 'cancelled' }
  // A message with nothing to speak (only code) is not read: the notice must not say it is.
  if (!speak(fallbackSpeech(markdown), { id, ...voice })) return { kind: 'silent' }
  return { kind: 'fallback', failure: result.failure, cut: fallbackIsCut(markdown) }
}

/** One click on the button: start, cancel the summary, pause or resume. */
export function toggleListen(phase: ListenPhase, start: () => void): void {
  if (phase === 'idle') start()
  else if (phase === 'summarizing') stopListening()
  else if (phase === 'playing') pauseSpeaking()
  else resumeSpeaking()
}

/** The phase of message `id`'s button. */
export function useListenPhase(id: string): ListenPhase {
  const summarizingId = useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => pending?.id ?? null
  )
  return listenPhase(id, summarizingId, useSpeech())
}

/**
 * The two sentences of the notice after a failed summary: why it failed (a usage limit has no line
 * of its own), then what is read instead: the start of the message only when it was cut.
 */
export function fallbackNoticeKeys(outcome: Extract<ListenOutcome, { kind: 'fallback' }>): [MessageKey, MessageKey] {
  const why = outcome.failure === 'noAccount' ? 'chat.listenNoAccount' : outcome.failure === 'timeout' ? 'chat.listenTimeout' : 'chat.listenFailed'
  return [why, outcome.cut ? 'chat.listenReadStart' : 'chat.listenReadWhole']
}
