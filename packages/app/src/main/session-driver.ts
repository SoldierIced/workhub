import { sessionIdentity, type AgentEvent, type DrivenSession } from '@workhub/core'
import { terminalChannel, type SessionView, type StartSessionInput } from '../shared/api'

/** What the driver needs from the session manager (its public surface). */
export interface DrivableSessions {
  list(): SessionView[]
  start(input: StartSessionInput): Promise<SessionView>
  prompt(id: string, text: string): Promise<string>
  /** Sends a prompt now, or null (nothing sent) while another prompt of the session is in flight. */
  tryPrompt(id: string, text: string): Promise<string> | null
  write(channelId: string, data: string): void
  cancel(id: string): Promise<void>
  stop(id: string): Promise<void>
  /** Drops a stopped or failed session from the list; false when it is still live. */
  remove(id: string): boolean
}

/**
 * Drives sessions on behalf of the Slack watcher and the automations: counts finished turns,
 * notes when a console last printed, and types text into a session's chat or its console. Fed
 * with the session manager's own `changed` and `event` streams.
 */
export class SessionDriver {
  private readonly turns = new Map<string, number>()
  private readonly lastState = new Map<string, SessionView['state']>()
  private readonly engine = new Map<string, 'app' | 'console'>()
  private readonly lastOutput = new Map<string, number>()
  private readonly identities = new Map<string, string>()
  private viewing: string | null = null
  /** Called when a session gets its real identity after starting (ACP agents). */
  onIdentityChanged: (oldKey: string, newKey: string) => void = () => undefined
  /** Called when a turn this driver typed into a chat ends, so the chat shows its end like the user's own turns. */
  onTurnEnded: (sessionId: string, stopReason: string) => void = () => undefined

  constructor(
    private readonly sessions: DrivableSessions,
    private readonly onPrompted: (sessionId: string, text: string) => void,
    private readonly now: () => number = Date.now
  ) {}

  onChanged(view: SessionView): void {
    const prev = this.lastState.get(view.id)
    if (prev === 'busy' && view.state === 'ready') this.turns.set(view.id, (this.turns.get(view.id) ?? 0) + 1)
    this.lastState.set(view.id, view.state)
    const identity = sessionIdentity(view)
    const before = this.identities.get(view.id)
    this.identities.set(view.id, identity)
    if (before && before !== identity) this.onIdentityChanged(before, identity)
    // The shell is shown next to the agent: the engine stays the last of app or console.
    if (view.mode !== 'shell') this.engine.set(view.id, view.mode)
  }

  onEvent(e: AgentEvent): void {
    if (e.type === 'output' && e.sessionId.endsWith(':console')) this.lastOutput.set(e.sessionId.slice(0, -':console'.length), this.now())
  }

  setViewing(sessionId: string | null): void {
    this.viewing = sessionId
  }

  views(): SessionView[] {
    return this.sessions.list()
  }

  list(): DrivenSession[] {
    return this.sessions.list().map((v) => ({
      id: v.id,
      identity: sessionIdentity(v),
      state: v.state,
      turnsEnded: this.turns.get(v.id) ?? 0,
      ...(this.lastOutput.has(v.id) ? { lastOutputAt: this.lastOutput.get(v.id)! } : {}),
      ...(v.error ? { error: v.error } : {}),
      onScreen: this.viewing === v.id
    }))
  }

  engineOf(view: SessionView): 'app' | 'console' {
    return this.engine.get(view.id) ?? (view.mode === 'console' ? 'console' : view.modes.includes('app') ? 'app' : 'console')
  }

  /**
   * Types text into the session: a prompt in the chat (the turn runs on; its end shows up as a
   * finished turn), or the text and Enter in the console. `waiting` while it is not idle, or
   * while another prompt (the user's queue, a review, a wake) is in flight: the caller retries.
   */
  async deliver(sessionId: string, text: string): Promise<'delivered' | 'waiting'> {
    const view = this.sessions.list().find((v) => v.id === sessionId)
    if (!view || view.state !== 'ready') return 'waiting'
    if (this.engineOf(view) === 'app') {
      let turn: Promise<string> | null
      try {
        turn = this.sessions.tryPrompt(sessionId, text)
      } catch {
        return 'waiting'
      }
      if (!turn) return 'waiting'
      this.onPrompted(sessionId, text)
      turn.then(
        (stopReason) => this.onTurnEnded(sessionId, stopReason),
        () => undefined
      )
      return 'delivered'
    }
    this.lastOutput.set(sessionId, this.now())
    this.sessions.write(terminalChannel(sessionId, 'console'), text.replace(/\r?\n/g, '\r') + '\r')
    return 'delivered'
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.sessions.cancel(sessionId)
  }

  async stop(sessionId: string): Promise<void> {
    await this.sessions.stop(sessionId)
  }

  /** Drops a stopped session the engine replaced: out of the list and out of the driver's own books. */
  async forget(sessionId: string): Promise<void> {
    if (!this.sessions.remove(sessionId)) return
    for (const m of [this.turns, this.lastState, this.engine, this.lastOutput, this.identities]) m.delete(sessionId)
    if (this.viewing === sessionId) this.viewing = null
  }
}
