import { useSyncExternalStore } from 'react'
import type { ImageInput, SessionState } from '@workhub/core'
import { PROMPT_WITHDRAWN } from '@shared/api'
import { imageInputFromDataUrl } from './lib/images'
import { PromptQueues, type QueuedPrompt, type SubmitOutcome } from './lib/prompt-queue'
import { pushItem, pushTurnEnd, pushUser } from './store'
import { SettleWaits } from './lib/settle-waits'

const listeners = new Set<() => void>()

/** Messages the user sent that were never sent to the agent because the session was interrupted. */
export type RecoveredPrompt = { text: string; images: string[] }
const recoveredListeners = new Set<(sessionId: string, prompts: RecoveredPrompt[]) => void>()

function recover(sessionId: string, prompts: RecoveredPrompt[]): void {
  if (prompts.length) for (const l of recoveredListeners) l(sessionId, prompts)
}

/** Prompts handed to main that wait to hear they went out, by session and token. */
const goingOut = new Map<string, () => void>()
/** Prompts whose answer came back, waiting for the turn's last events (see `SettleWaits`). */
const settles = new SettleWaits()
let followingStarts = false
function followStarts(): void {
  if (followingStarts) return
  followingStarts = true
  window.hub.sessions.onPromptStarted((id, token) => goingOut.get(`${id}:${token}`)?.())
  window.hub.sessions.onPromptSettled((id, token) => settles.notify(`${id}:${token}`))
}

/** How long a turn's end waits for main's notice before it shows anyway. */
const SETTLE_WAIT_MS = 2000
const afterSettled = (key: string) => settles.wait(key, SETTLE_WAIT_MS)

/**
 * Sends one prompt. It stays in the queued list while main holds it behind another prompt of the
 * session; the user's bubble goes in the chat when it actually goes out, the turn's end when it settles.
 */
async function deliver(sessionId: string, prompt: QueuedPrompt, started: () => void): Promise<void> {
  followStarts()
  const key = `${sessionId}:${prompt.id}`
  let shown = false
  const show = () => {
    if (shown) return
    shown = true
    goingOut.delete(key)
    started()
    pushUser(sessionId, prompt.text, prompt.images)
  }
  goingOut.set(key, show)
  const inputs = prompt.images.map(imageInputFromDataUrl).filter((i): i is ImageInput => i !== null)
  try {
    const stopReason = await window.hub.sessions.prompt(sessionId, prompt.text, inputs.length ? inputs : undefined, prompt.id)
    show()
    await afterSettled(key)
    pushTurnEnd(sessionId, stopReason)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    // Main dropped it before it went out: the user removed it (nothing to do) or interrupted the session.
    if (message.includes(PROMPT_WITHDRAWN)) {
      void afterSettled(key)
      if (queues.isHeld(sessionId, prompt.id)) recover(sessionId, [{ text: prompt.text, images: prompt.images }])
      return
    }
    show()
    pushItem(sessionId, 'error', message)
    // Main sends the notice for a failed prompt too: take it, so it is not kept.
    void afterSettled(key)
  } finally {
    goingOut.delete(key)
  }
}

const queues = new PromptQueues(
  deliver,
  () => {
    for (const l of listeners) l()
  },
  (sessionId, id) => void window.hub.sessions.withdrawPrompt(sessionId, id).catch(() => false)
)

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
