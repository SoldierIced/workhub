// The state of each host for Settings → Profiles: what WslHosts, the install and HostProcess report
// as events, reduced to one HostStatus per host id and sent to every window when it changes.
import { LOCAL_HOST_ID } from './hosts'
import type { HostInstallProgress, HostStatus } from '../shared/hosts-api'

export type HostStatusEvent =
  | { type: 'connecting' }
  | { type: 'installing'; progress: HostInstallProgress }
  /** `control`: whether its sessions reach Workhub's endpoint (the host offered a relay socket). */
  | { type: 'connected'; control: boolean }
  /** A connected host went away: it is started again, or it was given up on. */
  | { type: 'lost'; reason: string; restarting: boolean }
  | { type: 'failed'; detail: string }
  | { type: 'unavailable'; detail: string }

const kindOf = (id: string): HostStatus['kind'] => (id === LOCAL_HOST_ID ? 'local' : 'wsl')

/** The status after `event`; `previous` is that host's last one (undefined for a new host). */
export function reduceHostStatus(previous: HostStatus | undefined, id: string, event: HostStatusEvent): HostStatus {
  const base = { id, kind: previous?.kind ?? kindOf(id) }
  switch (event.type) {
    case 'connecting':
      return { ...base, state: 'connecting' }
    case 'installing':
      return { ...base, state: 'installing', installProgress: event.progress }
    case 'connected':
      return { ...base, state: 'connected', ...(event.control ? {} : { warning: 'noControl' as const }) }
    case 'lost':
      return { ...base, state: event.restarting ? 'connecting' : 'failed', detail: event.reason }
    case 'failed':
      return { ...base, state: 'failed', detail: event.detail }
    case 'unavailable':
      return { ...base, state: 'unavailable', detail: event.detail }
  }
}

/** Every host's status, `local` (always connected) first; `emit` gets the whole list after each change. */
export class HostStatusBoard {
  private readonly statuses = new Map<string, HostStatus>([[LOCAL_HOST_ID, { id: LOCAL_HOST_ID, kind: 'local', state: 'connected' }]])

  constructor(private readonly emit: (hosts: HostStatus[]) => void = () => {}) {}

  apply(id: string, event: HostStatusEvent): void {
    const next = reduceHostStatus(this.statuses.get(id), id, event)
    if (JSON.stringify(next) === JSON.stringify(this.statuses.get(id))) return
    this.statuses.set(id, next)
    this.emit(this.list())
  }

  get(id: string): HostStatus | undefined {
    return this.statuses.get(id)
  }

  list(): HostStatus[] {
    return [...this.statuses.values()]
  }
}
