import type { SessionState } from '../domain/session'

/**
 * Working time derived from a session's own state changes, for agents that do not report it:
 * the time spent `busy`, summed over the session's turns. Pure; the caller passes the clock.
 */
export class ActiveClock {
  private closedMs = 0
  private busySince: number | undefined

  /** The session moved to `state` at `at` (epoch ms). Repeating the current state changes nothing. */
  observe(state: SessionState, at: number): void {
    if (state === 'busy') {
      this.busySince ??= at
      return
    }
    if (this.busySince !== undefined) {
      this.closedMs += Math.max(0, at - this.busySince)
      this.busySince = undefined
    }
  }

  isBusy(): boolean {
    return this.busySince !== undefined
  }

  /** Working time up to `now`, an open turn included. */
  ms(now: number): number {
    return this.closedMs + (this.busySince !== undefined ? Math.max(0, now - this.busySince) : 0)
  }
}
