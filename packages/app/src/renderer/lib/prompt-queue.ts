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

/**
 * Sends one prompt and settles when its turn ends. `started` is called once the prompt actually
 * reaches the agent: main may hold it behind another prompt (a review, a Slack wake) first.
 */
export type Deliver = (sessionId: string, prompt: QueuedPrompt, started: () => void) => Promise<void>

/**
 * Messages waiting per session, delivered one at a time in order when the session is ready and no
 * prompt of ours is still running. A message handed to main stays listed (and removable, through
 * `withdraw`) until main reports it went out.
 */
export class PromptQueues {
  private queues = new Map<string, QueuedPrompt[]>()
  /** Handed to main, not gone out yet: main holds them behind another prompt of the session. */
  private held = new Map<string, QueuedPrompt[]>()
  /** What `list` returns: held then queued, one array per change so React sees a stable snapshot. */
  private shown = new Map<string, readonly QueuedPrompt[]>()
  private inFlight = new Map<string, number>()
  private states = new Map<string, SessionState>()
  private seq = 0

  constructor(
    private readonly deliver: Deliver,
    private readonly changed: () => void = () => undefined,
    private readonly withdraw: (sessionId: string, id: number) => void = () => undefined
  ) {}

  /** The messages not sent yet, oldest first: those main holds, then those waiting here. */
  list(sessionId: string): readonly QueuedPrompt[] {
    return this.shown.get(sessionId) ?? EMPTY
  }

  /** Main still holds this message (handed over, not gone out). */
  isHeld(sessionId: string, id: number): boolean {
    return this.held.get(sessionId)?.some((p) => p.id === id) ?? false
  }

  /** Sends, injects or queues a message by the session's state; `refused` when the session takes none. */
  submit(sessionId: string, state: SessionState, midTurnInput: boolean, text: string, images: string[] = []): SubmitOutcome {
    this.states.set(sessionId, state)
    const mode = submitMode(state, midTurnInput, this.waiting(sessionId).length, this.inFlight.get(sessionId) ?? 0)
    const prompt = { id: ++this.seq, text, images }
    if (mode === 'sent' || mode === 'injected') this.run(sessionId, prompt)
    else if (mode === 'queued') {
      this.queues.set(sessionId, [...this.waiting(sessionId), prompt])
      this.touch(sessionId)
    }
    return mode
  }

  /** Takes a message out before it is sent (asking main to drop it when main holds it); false when it already went. */
  remove(sessionId: string, id: number): boolean {
    if (this.isHeld(sessionId, id)) {
      this.unhold(sessionId, id)
      this.withdraw(sessionId, id)
      return true
    }
    const list = this.waiting(sessionId)
    const next = list.filter((p) => p.id !== id)
    if (next.length === list.length) return false
    this.set(sessionId, next)
    this.touch(sessionId)
    return true
  }

  /**
   * The user interrupted the session: its waiting messages are taken out (never sent after the
   * interrupted turn) and handed back, oldest first, so the composer can offer them again. Those
   * main holds are dropped there by the interrupt and come back through their failed delivery.
   */
  takeAll(sessionId: string): QueuedPrompt[] {
    const list = [...this.waiting(sessionId)]
    if (!list.length) return list
    this.queues.delete(sessionId)
    this.touch(sessionId)
    return list
  }

  /** The session is gone: its waiting messages go with it. */
  drop(sessionId: string): void {
    this.states.delete(sessionId)
    this.inFlight.delete(sessionId)
    const queued = this.queues.delete(sessionId)
    const held = this.held.delete(sessionId)
    if (queued || held) this.touch(sessionId)
  }

  /** The session's state changed: a ready session gets its next waiting message. */
  stateChanged(sessionId: string, state: SessionState): void {
    this.states.set(sessionId, state)
    this.drain(sessionId)
  }

  private waiting(sessionId: string): readonly QueuedPrompt[] {
    return this.queues.get(sessionId) ?? EMPTY
  }

  private drain(sessionId: string): void {
    const [next, ...rest] = this.waiting(sessionId)
    if (!next || this.states.get(sessionId) !== 'ready' || (this.inFlight.get(sessionId) ?? 0) > 0) return
    this.set(sessionId, rest)
    this.run(sessionId, next)
  }

  private run(sessionId: string, prompt: QueuedPrompt): void {
    this.inFlight.set(sessionId, (this.inFlight.get(sessionId) ?? 0) + 1)
    this.held.set(sessionId, [...(this.held.get(sessionId) ?? []), prompt])
    this.touch(sessionId)
    void this.deliver(sessionId, prompt, () => this.unhold(sessionId, prompt.id))
      .catch(() => undefined)
      .finally(() => {
        this.unhold(sessionId, prompt.id)
        const left = (this.inFlight.get(sessionId) ?? 1) - 1
        if (left > 0) this.inFlight.set(sessionId, left)
        else this.inFlight.delete(sessionId)
        this.drain(sessionId)
      })
  }

  private unhold(sessionId: string, id: number): void {
    const list = this.held.get(sessionId)
    if (!list?.some((p) => p.id === id)) return
    const next = list.filter((p) => p.id !== id)
    if (next.length) this.held.set(sessionId, next)
    else this.held.delete(sessionId)
    this.touch(sessionId)
  }

  private set(sessionId: string, list: QueuedPrompt[]): void {
    if (list.length) this.queues.set(sessionId, list)
    else this.queues.delete(sessionId)
  }

  /** Rebuilds what `list` shows for the session and tells the listeners. */
  private touch(sessionId: string): void {
    const all = [...(this.held.get(sessionId) ?? []), ...this.waiting(sessionId)]
    const before = this.list(sessionId)
    if (all.length === before.length && all.every((p, i) => p === before[i])) return
    if (all.length) this.shown.set(sessionId, all)
    else this.shown.delete(sessionId)
    this.changed()
  }
}

const EMPTY: readonly QueuedPrompt[] = []

/**
 * The composer after an interrupt: the messages that were not sent come back, oldest first, ahead
 * of what was being typed, joined by blank lines; their images join the attached ones.
 */
export function restoreComposer(
  current: { text: string; images: string[] },
  recovered: readonly { text: string; images: string[] }[],
  maxImages: number
): { text: string; images: string[] } {
  const text = [...recovered.map((p) => p.text.trim()), current.text.trim()].filter(Boolean).join('\n\n')
  const images = [...recovered.flatMap((p) => p.images), ...current.images].slice(0, maxImages)
  return { text, images }
}
