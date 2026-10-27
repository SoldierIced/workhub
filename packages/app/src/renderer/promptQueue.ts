import { useSyncExternalStore } from 'react'
import type { ImageInput, SessionState } from '@workhub/core'
import { PROMPT_WITHDRAWN } from '@shared/api'
import { imageInputFromDataUrl } from './lib/images'
import { PromptQueues, type QueuedPrompt, type SubmitOutcome } from './lib/prompt-queue'
import { pushItem, pushTurnEnd, pushUser, removeItem } from './store'

const listeners = new Set<() => void>()

/** Messages the user sent that were never sent to the agent because the session was interrupted. */
export type RecoveredPrompt = { text: string; images: string[] }
const recoveredListeners = new Set<(sessionId: string, prompts: RecoveredPrompt[]) => void>()

function recover(sessionId: string, prompts: RecoveredPrompt[]): void {
  if (prompts.length) for (const l of recoveredListeners) l(sessionId, prompts)
}

/** Sends one prompt: the user's bubble goes in the chat now, the turn's end when it settles. */
async function deliver(sessionId: string, prompt: { text: string; images: string[] }): Promise<void> {
  const bubble = pushUser(sessionId, prompt.text, prompt.images)
  const inputs = prompt.images.map(imageInputFromDataUrl).filter((i): i is ImageInput => i !== null)
  try {
    pushTurnEnd(sessionId, await window.hub.sessions.prompt(sessionId, prompt.text, inputs.length ? inputs : undefined))
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    // It waited behind another prompt (a review, a wake) and the user interrupted: it never went out.
    if (message.includes(PROMPT_WITHDRAWN)) {
      removeItem(sessionId, bubble)
      return recover(sessionId, [prompt])
    }
    pushItem(sessionId, 'error', message)
  }
}

const queues = new PromptQueues(deliver, () => {
  for (const l of listeners) l()
})

let started = false
/** Follows session states so waiting messages go out when their session turns ready. */
export function startPromptQueue(): void {
  if (started) return
  started = true
  window.hub.sessions.onChanged((view) => queues.stateChanged(view.id, view.state))
  window.hub.sessions.onRemoved((id) => queues.drop(id))
}

/** Sends, injects into the running turn, or queues a message, by the session's state. */
export function submitPrompt(sessionId: string, state: SessionState, midTurnInput: boolean, text: string, images: string[] = []): SubmitOutcome {
  return queues.submit(sessionId, state, midTurnInput, text, images)
}

/**
 * Esc or Interrupt: the waiting messages are taken out first, so none goes out once the interrupted
 * turn ends, then the turn is cancelled. They come back through `onRecoveredPrompts`.
 */
export function interruptSession(sessionId: string): Promise<void> {
  recover(sessionId, queues.takeAll(sessionId).map(({ text, images }) => ({ text, images })))
  return window.hub.sessions.cancel(sessionId)
}

/** Messages handed back after an interrupt (queued, or dropped before they were sent). */
export function onRecoveredPrompts(cb: (sessionId: string, prompts: RecoveredPrompt[]) => void): () => void {
  recoveredListeners.add(cb)
  return () => recoveredListeners.delete(cb)
}

export function removeQueuedPrompt(sessionId: string, id: number): void {
  queues.remove(sessionId, id)
}

/** The messages waiting for a session's turn to end, oldest first. */
export function useQueuedPrompts(sessionId: string): readonly QueuedPrompt[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => queues.list(sessionId)
  )
}
