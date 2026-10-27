import { PROMPT_WITHDRAWN } from '../shared/api'

/** A prompt that waited for its turn and was dropped because the session was interrupted or stopped. */
export class PromptWithdrawnError extends Error {
  constructor() {
    super(`${PROMPT_WITHDRAWN}: the session was interrupted before this message was sent`)
    this.name = 'PromptWithdrawnError'
  }
}

interface Waiter {
  start(): void
  withdraw(): void
}

/** A session's prompts: present while one is in flight; `waiting` queue behind it in order. */
interface Lane {
  waiting: Waiter[]
}

/**
 * One prompt in flight per session. Every prompt source (the composer's queue, the AI review,
 * the local review, automations, Slack wakes) goes through here, so two of them never reach an
 * agent that cannot take input mid-turn at the same moment. `run` waits its turn; `tryRun` is for
 * sources that keep their own retry and would rather hear "busy" than wait.
 */
export class SendGate {
  private readonly lanes = new Map<string, Lane>()

  /** A prompt runs or waits for this session. */
  busy(sessionId: string): boolean {
    return this.lanes.has(sessionId)
  }

  /** Runs `send` once no other prompt of the session is in flight. */
  run<T>(sessionId: string, send: () => Promise<T>): Promise<T> {
    const lane = this.lanes.get(sessionId)
    if (!lane) {
      const fresh: Lane = { waiting: [] }
      this.lanes.set(sessionId, fresh)
      return this.exec(sessionId, fresh, send)
    }
    return new Promise<T>((resolve, reject) => {
      lane.waiting.push({
        start: () => void this.exec(sessionId, lane, send).then(resolve, reject),
        withdraw: () => reject(new PromptWithdrawnError())
      })
    })
  }

  /** Runs `send` now, or returns null (and runs nothing) while another prompt runs or waits. */
  tryRun<T>(sessionId: string, send: () => Promise<T>): Promise<T> | null {
    return this.busy(sessionId) ? null : this.run(sessionId, send)
  }

  /** Drops the prompts still waiting (the one in flight runs on); returns how many were dropped. */
  withdraw(sessionId: string): number {
    const lane = this.lanes.get(sessionId)
    if (!lane) return 0
    const dropped = lane.waiting.splice(0)
    for (const w of dropped) w.withdraw()
    return dropped.length
  }

  private exec<T>(sessionId: string, lane: Lane, send: () => Promise<T>): Promise<T> {
    let turn: Promise<T>
    try {
      turn = send()
    } catch (e) {
      turn = Promise.reject(e)
    }
    return turn.finally(() => this.release(sessionId, lane))
  }

  private release(sessionId: string, lane: Lane): void {
    const next = lane.waiting.shift()
    if (next) return next.start()
    if (this.lanes.get(sessionId) === lane) this.lanes.delete(sessionId)
  }
}
