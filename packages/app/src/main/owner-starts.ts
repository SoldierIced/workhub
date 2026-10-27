import { sessionIdentity } from '@workhub/core'
import type { SessionView, StartSessionInput } from '../shared/api'

export interface OwnerStartsDeps {
  views(): SessionView[]
  start(input: StartSessionInput): Promise<SessionView>
}

/**
 * Opens a session by its identity once. The sidebar's reopen and a Slack wake can ask for the same
 * closed session at the same moment: while one start runs every other caller gets that start, and
 * a session already open under that identity is returned instead of a copy.
 */
export class OwnerStarts {
  private readonly starting = new Map<string, Promise<SessionView>>()

  constructor(private readonly deps: OwnerStartsDeps) {}

  start(identity: string, input: StartSessionInput): Promise<SessionView> {
    const inFlight = this.starting.get(identity)
    if (inFlight) return inFlight
    const open = this.deps
      .views()
      .filter((v) => sessionIdentity(v) === identity && v.state !== 'stopped' && v.state !== 'error')
      .sort((a, b) => b.startedAt - a.startedAt)[0]
    if (open) return Promise.resolve(open)
    let started: Promise<SessionView>
    try {
      started = this.deps.start(input)
    } catch (e) {
      started = Promise.reject(e)
    }
    const tracked = started.finally(() => {
      if (this.starting.get(identity) === tracked) this.starting.delete(identity)
    })
    this.starting.set(identity, tracked)
    return tracked
  }
}
