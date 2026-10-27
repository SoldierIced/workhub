import type { SessionState } from '@workhub/core'

/** A message the user sent while the agent was working, waiting for the turn to end. */
export interface QueuedPrompt {
  id: number
  text: string
  /** Data URLs of the pasted images. */
  images: string[]
}

/** What became of a message the user sent: out now, folded into the running turn, waiting, or refused. */
export type SubmitOutcome = 'sent' | 'injected' | 'queued' | 'refused'

/** Whether the composer takes messages in this state (sent, injected or queued). */
export function acceptsInput(state: SessionState): boolean {
  return state === 'ready' || state === 'busy' || state === 'starting'
}

/**
 * How a message sent now goes out. Ready with nothing waiting: straight away. Busy on an agent
 * that takes input mid-turn (Claude Code folds it in between tool rounds): injected, unless older
 * messages still wait (order wins). Otherwise it waits for the turn to end.
 */
export function submitMode(state: SessionState, midTurnInput: boolean, queued: number, inFlight: number): SubmitOutcome {
  if (!acceptsInput(state)) return 'refused'
  if (queued > 0) return 'queued'
  if (state === 'ready' && inFlight === 0) return 'sent'
  if (state === 'busy' && midTurnInput) return 'injected'
  return 'queued'
}

export type Deliver = (sessionId: string, prompt: { text: string; images: string[] }) => Promise<void>

/**
 * Messages waiting per session, delivered one at a time in order when the session is ready and no
 * prompt of ours is still running. `deliver` sends one prompt and settles when its turn ends.
 */
export class PromptQueues {
  private queues = new Map<string, QueuedPrompt[]>()
  private inFlight = new Map<string, number>()
  private states = new Map<string, SessionState>()
  private seq = 0

  constructor(
    private readonly deliver: Deliver,
    private readonly changed: () => void = () => undefined
  ) {}

  list(sessionId: string): readonly QueuedPrompt[] {
    return this.queues.get(sessionId) ?? EMPTY
  }

  /** Sends, injects or queues a message by the session's state; `refused` when the session takes none. */
  submit(sessionId: string, state: SessionState, midTurnInput: boolean, text: string, images: string[] = []): SubmitOutcome {
    this.states.set(sessionId, state)
    const mode = submitMode(state, midTurnInput, this.list(sessionId).length, this.inFlight.get(sessionId) ?? 0)
    if (mode === 'sent' || mode === 'injected') this.run(sessionId, { text, images })
    else if (mode === 'queued') {
      this.queues.set(sessionId, [...this.list(sessionId), { id: ++this.seq, text, images }])
      this.changed()
    }
    return mode
  }

  /** Takes a waiting message out before it is sent; false when it already went. */
  remove(sessionId: string, id: number): boolean {
    const list = this.list(sessionId)
    const next = list.filter((p) => p.id !== id)
    if (next.length === list.length) return false
    this.set(sessionId, next)
    this.changed()
    return true
  }

  /** The session is gone: its waiting messages go with it. */
  drop(sessionId: string): void {
    this.states.delete(sessionId)
    this.inFlight.delete(sessionId)
    if (this.queues.delete(sessionId)) this.changed()
  }

  /** The session's state changed: a ready session gets its next waiting message. */
  stateChanged(sessionId: string, state: SessionState): void {
    this.states.set(sessionId, state)
    this.drain(sessionId)
  }

  private drain(sessionId: string): void {
    const [next, ...rest] = this.list(sessionId)
    if (!next || this.states.get(sessionId) !== 'ready' || (this.inFlight.get(sessionId) ?? 0) > 0) return
    this.set(sessionId, rest)
    this.changed()
    this.run(sessionId, next)
  }

  private run(sessionId: string, prompt: { text: string; images: string[] }): void {
    this.inFlight.set(sessionId, (this.inFlight.get(sessionId) ?? 0) + 1)
    void this.deliver(sessionId, prompt)
      .catch(() => undefined)
      .finally(() => {
        const left = (this.inFlight.get(sessionId) ?? 1) - 1
        if (left > 0) this.inFlight.set(sessionId, left)
        else this.inFlight.delete(sessionId)
        this.drain(sessionId)
      })
  }

  private set(sessionId: string, list: QueuedPrompt[]): void {
    if (list.length) this.queues.set(sessionId, list)
    else this.queues.delete(sessionId)
  }
}

const EMPTY: readonly QueuedPrompt[] = []
