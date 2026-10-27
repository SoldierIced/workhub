import { useSyncExternalStore } from 'react'
import type { ImageInput, SessionState } from '@workhub/core'
import { imageInputFromDataUrl } from './lib/images'
import { PromptQueues, type QueuedPrompt, type SubmitOutcome } from './lib/prompt-queue'
import { pushItem, pushTurnEnd, pushUser } from './store'

const listeners = new Set<() => void>()

/** Sends one prompt: the user's bubble goes in the chat now, the turn's end when it settles. */
async function deliver(sessionId: string, prompt: { text: string; images: string[] }): Promise<void> {
  pushUser(sessionId, prompt.text, prompt.images)
  const inputs = prompt.images.map(imageInputFromDataUrl).filter((i): i is ImageInput => i !== null)
  try {
    pushTurnEnd(sessionId, await window.hub.sessions.prompt(sessionId, prompt.text, inputs.length ? inputs : undefined))
  } catch (e) {
    pushItem(sessionId, 'error', e instanceof Error ? e.message : String(e))
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
