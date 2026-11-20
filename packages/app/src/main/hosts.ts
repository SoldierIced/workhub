// The hosts sessions run on: this computer (the `local` host), and the hosts profiles name (a WSL
// distribution, `wsl:<distro>`), whose services reach them through a HostClient. `hostFor` picks
// one from the profile.
//
// The fallback rule: a session never runs on this computer in place of the host its profile names
// (its folder is a path there, a Linux one for WSL), so sessions use `sessionHostFor`, which waits
// for that host (bounded) and fails with the reason when it cannot connect. Only read-only folder
// work (listing pull requests, reading a repository's origin) uses `hostFor`, which falls back to
// this computer while the named host is not connected: at worst it finds nothing there.
import { existsSync } from 'node:fs'
import type { GitRunner } from '@workhub/adapters/git-review'
import { statPath, type HostFileInfo } from '@workhub/adapters/host'
import { hostIdOf, type AgentRuntime, type ProfileHost, type SessionHistorySource, type TranscriptReader } from '@workhub/core'

export type { HostFileInfo }

export type HostId = 'local' | (string & {})

/** The host of this computer: the one every session runs on until profiles name another. */
export const LOCAL_HOST_ID = 'local'

/** How long a session waits for the host its profile names to connect before it gives up. */
export const HOST_WAIT_TIMEOUT_MS = 5 * 60_000

/** A named host that has not connected yet: its id now (a session shows it), the host once it connects. */
export interface PendingHost {
  id: HostId
  /** Rejects with "<host> is not available: <reason>" when it fails, or does not connect in time. */
  ready: Promise<SessionHost>
}

/** A host's name in messages: `WSL host Ubuntu` for `wsl:Ubuntu`. */
export function hostLabel(id: HostId): string {
  return id.startsWith('wsl:') ? `WSL host ${id.slice(4)}` : `host ${id}`
}

/** The error of a session whose host is not there. */
export function hostUnavailable(id: HostId, reason: string): Error {
  return new Error(`${hostLabel(id)} is not available: ${reason}`)
}

/** What a host is picked by: the profile a session (or a folder) belongs to. */
export interface HostTarget {
  profileId: string | null
}

/** The folder operations the app runs on a session's or profile's folders, where those folders live. */
export interface HostFolders {
  /** Runs git in a folder of the host; never rejects (a failure is `ok: false`). */
  git: GitRunner
  /** Whether a path exists on the host. */
  exists(path: string): Promise<boolean>
  /** A path's size, times and kind on the host; null when it cannot be read (missing, no access). */
  stat(path: string): Promise<HostFileInfo | null>
}

/**
 * What sessions run on, as ports: built in this process (ExecutionServices is one), or reached
 * through a HostClient (the remote proxies).
 */
export interface HostServices {
  runtimes: { native: AgentRuntime; acp: AgentRuntime; terminal: AgentRuntime }
  /** The runtime of consoles and shells (the same as `runtimes.terminal`). */
  terminal: AgentRuntime
  transcripts: TranscriptReader[]
  history: Partial<Record<string, SessionHistorySource>>
  git: GitRunner
}

/** How sessions on a host reach Workhub: the host's relay socket and Workhub's MCP server there. */
export interface HostControlInfo {
  /** The host's Unix socket, relayed to main's endpoint (`host-control.ts`). */
  socket: string
  /** The Node the host runs on (Electron as Node for the child host). */
  node: string
  /** `workhub-mcp.mjs` in the host's bridge folder. */
  mcpScript: string
}

/** A place sessions run: its agent runtimes, transcript readers, past sessions, and its folders. */
export interface SessionHost extends HostFolders {
  id: HostId
  services: HostServices
  /**
   * How its sessions reach Workhub: undefined for main's own endpoint (this computer, or a child
   * host on Windows, where no socket is relayed), null for a host that offers none.
   */
  control?: HostControlInfo | null
}

/** Picks the host of a session or folder. */
export type HostResolver = (target: HostTarget) => SessionHost

/** `stat` on this computer's disk. */
export const localStat: (path: string) => Promise<HostFileInfo | null> = statPath

/** The host of this computer, over services built in this process. */
export function localHost(services: HostServices): SessionHost {
  return {
    id: LOCAL_HOST_ID,
    services,
    git: services.git,
    exists: async (path) => existsSync(path),
    stat: localStat
  }
}

/** The URL of a folder's `origin` remote; null when the folder is not a git repository or has no origin. */
export async function originUrl(git: GitRunner, folder: string): Promise<string | null> {
  const r = await git(folder, ['remote', 'get-url', 'origin'], { timeoutMs: 10_000 })
  return r.ok ? r.stdout.trim() : null
}

/** The host a profile names (`profile.host`); undefined for an unknown profile or one that names none. */
export type ProfileHostLookup = (profileId: string) => ProfileHost | undefined

/** The known hosts, `local` always among them. */
export class HostRegistry {
  private readonly hosts = new Map<HostId, SessionHost>()
  private preferred: HostId | null = null
  /** Why each named host that failed is not there, until it is started again. */
  private readonly failures = new Map<HostId, string>()
  /** Sessions waiting for a named host to connect, or to fail. */
  private readonly waiting = new Map<HostId, Set<(outcome: SessionHost | Error) => void>>()

  constructor(
    readonly local: SessionHost,
    private readonly profileHost: ProfileHostLookup = () => undefined
  ) {
    if (local.id !== LOCAL_HOST_ID) throw new Error(`the local host must have the id "${LOCAL_HOST_ID}"`)
    this.hosts.set(local.id, local)
  }

  /** Adds a host, or replaces the one with the same id (a restarted host process). Never the local one. */
  register(host: SessionHost): void {
    if (host.id === LOCAL_HOST_ID) throw new Error('the local host cannot be replaced')
    this.hosts.set(host.id, host)
    this.failures.delete(host.id)
    this.settle(host.id, host)
  }

  /**
   * A named host could not start, or was given up on: it leaves the registry, and the sessions
   * waiting for it (and those started later, until it is started again) fail with the reason.
   */
  failed(id: HostId, reason: string): void {
    if (id === LOCAL_HOST_ID) return
    this.hosts.delete(id)
    this.failures.set(id, reason)
    this.settle(id, hostUnavailable(id, reason))
  }

  /** A named host is being started (again, after a retry): new sessions wait for it instead of failing. */
  starting(id: HostId): void {
    this.failures.delete(id)
  }

  private settle(id: HostId, outcome: SessionHost | Error): void {
    const waiters = this.waiting.get(id)
    this.waiting.delete(id)
    for (const w of waiters ?? []) w(outcome)
  }

  get(id: HostId): SessionHost | undefined {
    return this.hosts.get(id)
  }

  /**
   * Runs the profiles that name no host on this one while it is registered: the development switch
   * `WORKHUB_HOST=child`. Null goes back to this computer. A profile's own `host` always wins.
   */
  prefer(id: HostId | null): void {
    this.preferred = id
  }

  /**
   * The host a session or folder of this profile runs on: the one the profile names, else the
   * preferred one, else this computer. A named host that is not registered (not connected yet, or
   * failed to start) falls back to this computer.
   */
  hostFor(target: HostTarget): SessionHost {
    const named = target.profileId !== null ? this.profileHost(target.profileId) : undefined
    if (named) return this.hosts.get(hostIdOf(named)) ?? this.local
    return (this.preferred !== null ? this.hosts.get(this.preferred) : undefined) ?? this.local
  }

  /**
   * The host a session of this profile runs on. Unlike `hostFor`, a host the profile names that
   * has not connected yet is waited for (at most `timeoutMs`), never replaced by this computer;
   * one that failed rejects at once with its reason.
   */
  sessionHostFor(target: HostTarget, timeoutMs = HOST_WAIT_TIMEOUT_MS): SessionHost | PendingHost {
    const named = target.profileId !== null ? this.profileHost(target.profileId) : undefined
    const id = named ? hostIdOf(named) : LOCAL_HOST_ID
    if (id === LOCAL_HOST_ID) return this.hostFor(target)
    const host = this.hosts.get(id)
    if (host) return host
    const failure = this.failures.get(id)
    if (failure !== undefined) return { id, ready: handled(Promise.reject(hostUnavailable(id, failure))) }
    const ready = new Promise<SessionHost>((resolve, reject) => {
      const done = (outcome: SessionHost | Error) => {
        clearTimeout(timer)
        this.waiting.get(id)?.delete(done)
        if (outcome instanceof Error) reject(outcome)
        else resolve(outcome)
      }
      const timer = setTimeout(() => done(hostUnavailable(id, `it did not connect within ${Math.round(timeoutMs / 1000)} s`)), timeoutMs)
      timer.unref?.()
      const waiters = this.waiting.get(id) ?? new Set()
      waiters.add(done)
      this.waiting.set(id, waiters)
    })
    return { id, ready: handled(ready) }
  }
}

/** The promise itself, marked handled: a caller may attach its handlers only after other awaits. */
function handled<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => undefined)
  return promise
}
