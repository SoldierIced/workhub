// A `workhub host` in a child process of the app, its execution services reached over the child's
// stdio. By default the app's own executable runs as Node on the bundled host entry
// (WORKHUB_HOST=child); a `launch` starts it some other way (`wsl.exe` into a distribution).
import { spawn as nodeSpawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import { HOST_PROTOCOL_VERSION, NO_CAPABILITIES, type HostLaunch } from '@workhub/core'
import {
  HOST_INFO_METHOD,
  HostChannel,
  HostClient,
  HostHelloError,
  hostInfoSchema,
  connectRemoteAgentRuntime,
  connectRemoteHistorySources,
  connectRemoteTranscriptReaders,
  remoteFolders,
  remoteGitRunner
} from '@workhub/adapters/host'
import { killProcessTree } from '@workhub/adapters/spawn-plan'
import { answerRelayedControl, type ControlServe } from './host-control'
import type { Logger } from './log-file'
import type { HostControlInfo, SessionHost } from './hosts'

export const CHILD_HOST_ID = 'child'

/** The parts of a ChildProcess HostProcess uses (faked in tests). */
export interface HostChild {
  readonly pid?: number
  readonly stdin: Writable
  readonly stdout: Readable
  readonly stderr: Readable
  kill(signal?: NodeJS.Signals | number): boolean
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  once(event: 'error', listener: (err: Error) => void): unknown
}

export type HostSpawn = (command: string, args: string[], env: NodeJS.ProcessEnv) => HostChild

export interface HostProcessOptions {
  /** The id the host is known by (`HostRegistry`); `child` by default. */
  id?: string
  /** The bundled host entry (out/main/host.js), run by the default launch. */
  entry?: string
  /** Arguments after `--stdio` and the version (bridge folder, PATH folders), for the default launch. */
  args?: string[]
  /**
   * How the host is started, asked again at each restart. Its `env` is set over `env` (or the
   * app's environment). By default `execPath` runs `entry` as Node (ELECTRON_RUN_AS_NODE).
   */
  launch?: () => HostLaunch
  /** The host build this app expects; the child is told to say it, and refused when it does not. */
  hostVersion: string
  log: Pick<Logger, 'info' | 'warn' | 'error'>
  /** A host that connected after a restart; sessions started from now on run on it. */
  onRestart?: (host: SessionHost) => void
  /** A host that had connected went away: `restarting` when it is started again, false once given up on. */
  onLost?: (reason: string, restarting: boolean) => void
  /** The Node the entry runs on; the app's own executable (as Node) by default. */
  execPath?: string
  env?: NodeJS.ProcessEnv
  spawn?: HostSpawn
  /** Ends a child; its process tree by default. */
  kill?: (child: HostChild) => void
  /** Delay before the first restart, doubled after each failed one up to `maxMs`. */
  backoff?: { initialMs: number; maxMs: number }
  helloTimeoutMs?: number
  /** Serves the control requests the host relays from its socket (`host-control.ts`); null while main's endpoint is down. */
  serveControl?: () => ControlServe | null
}

const DEFAULT_BACKOFF = { initialMs: 1_000, maxMs: 60_000 }

const defaultSpawn: HostSpawn = (command, args, env) => nodeSpawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** Starts the child, keeps it running (restarting it with backoff when it goes away) and stops it. */
export class HostProcess {
  private child: HostChild | undefined
  private client: HostClient | undefined
  private restartTimer: ReturnType<typeof setTimeout> | undefined
  private failures = 0
  /** Set once a first host connected: from then on a lost host is restarted. */
  private supervising = false
  private gaveUp = false
  private stopped = false
  /** Children that exited or were signalled: never signalled again (an exited one's pid may be reused). */
  private readonly ended = new WeakSet<HostChild>()

  constructor(private readonly options: HostProcessOptions) {}

  /** Starts the child and resolves with its host once the hello and the service listing are done. */
  async connect(): Promise<SessionHost> {
    const host = await this.launch()
    this.supervising = true
    return host
  }

  /** Ends the child for good (the app quits); no restart follows. */
  stop(): void {
    this.stopped = true
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = undefined
    this.end()
  }

  private async launch(): Promise<SessionHost> {
    const { options } = this
    const { command, args, env } = (options.launch ?? (() => this.nodeLaunch()))()
    const child = (options.spawn ?? defaultSpawn)(command, args, { ...(options.env ?? process.env), ...env })
    this.child = child
    // The host writes its diagnostics to stderr: they go to the app's log.
    createInterface({ input: child.stderr }).on('line', (line) => options.log.info(`host: ${line}`))
    const channel = new HostChannel(child.stdout, child.stdin, { onNotice: (n) => options.log.warn(`host: malformed line (${n.reason})`) })
    const client = new HostClient(channel, {
      expected: { protocol: HOST_PROTOCOL_VERSION, hostVersion: options.hostVersion },
      helloTimeoutMs: options.helloTimeoutMs,
      onNotice: (n) => options.log.warn(`host: unexpected ${n.kind}`)
    })
    this.client = client
    if (options.serveControl) answerRelayedControl(client, options.serveControl, (m) => options.log.warn(m))
    let lost = false
    // Until the hello is settled a loss is only noted: the outcome of the connection decides what is
    // reported (a refused host is given up on, once, with its own reason).
    let settled = false
    let lostEarly: string | undefined
    const onLost = (reason: string) => {
      if (lost) return
      if (!settled) {
        lostEarly ??= reason
        return
      }
      lost = true
      this.lost(child, client, reason)
    }
    child.once('exit', (code, signal) => {
      this.ended.add(child)
      onLost(`the host process exited (${signal ?? code})`)
    })
    child.once('error', (err) => onLost(`the host process failed: ${err.message}`))
    client.onClose(onLost)
    try {
      await client.ready
      settled = true
      if (lostEarly !== undefined) onLost(lostEarly)
      return await this.build(client)
    } catch (err) {
      settled = true
      options.log.error(`host: could not connect: ${message(err)}`)
      if (err instanceof HostHelloError && err.reason !== 'timeout' && err.reason !== 'closed') {
        this.gaveUp = true
        lost = true
        client.close()
        this.end(child)
        // A restart that cannot be used: no further one follows, and this is its only report.
        if (this.supervising) options.onLost?.(message(err), false)
      } else {
        onLost(lostEarly ?? 'the connection failed')
      }
      throw err
    }
  }

  /** The entry, run as Node by the app's own executable (or `execPath`). */
  private nodeLaunch(): HostLaunch {
    const { options } = this
    if (!options.entry) throw new Error('a host process needs an entry or a launch')
    return {
      command: options.execPath ?? process.execPath,
      args: [options.entry, '--stdio', '--host-version', options.hostVersion, ...(options.args ?? [])],
      env: { ELECTRON_RUN_AS_NODE: '1' }
    }
  }

  private async build(client: HostClient): Promise<SessionHost> {
    const onError = (err: unknown) => this.options.log.warn(`host: ${message(err)}`)
    const [native, acp, terminal, transcripts, history] = await Promise.all([
      connectRemoteAgentRuntime(client, 'native', { onError }),
      connectRemoteAgentRuntime(client, 'acp', { onError }),
      // A raw terminal reports nothing structured, whatever the agent could do in app mode.
      connectRemoteAgentRuntime(client, 'terminal', { capabilities: () => ({ ...NO_CAPABILITIES }), onError }),
      connectRemoteTranscriptReaders(client, { timeoutMs: 60_000, onError }),
      connectRemoteHistorySources(client, { timeoutMs: 120_000 })
    ])
    const git = remoteGitRunner(client)
    const folders = remoteFolders(client)
    const control = await this.controlInfo(client)
    return {
      id: this.options.id ?? CHILD_HOST_ID,
      services: { runtimes: { native, acp, terminal }, terminal, transcripts, history, git },
      git,
      exists: folders.exists,
      stat: folders.stat,
      realpath: folders.realpath,
      ...(control === undefined ? {} : { control })
    }
  }

  /**
   * How the host's sessions reach Workhub (`host.info`): its relay socket. Without one, a child on
   * this computer (the default launch) leaves them on main's own endpoint, any other host gives none.
   */
  private async controlInfo(client: HostClient): Promise<HostControlInfo | null | undefined> {
    const fallback = this.options.launch ? null : undefined
    try {
      const info = hostInfoSchema.parse(await client.request(HOST_INFO_METHOD))
      return info.control ? { socket: info.control.socket, node: info.node, mcpScript: info.mcpScript } : fallback
    } catch (err) {
      this.options.log.warn(`host: no control endpoint for its sessions: ${message(err)}`)
      return fallback
    }
  }

  /**
   * The child or its channel went away. Sessions still live on it get an error from their runtime
   * proxy; the child is ended if it is still there, and started again once the first host was up.
   */
  private lost(child: HostChild, client: HostClient, reason: string): void {
    client.close()
    this.end(child)
    if (this.stopped || !this.supervising || this.restartTimer) return
    if (this.gaveUp) {
      this.options.onLost?.(reason, false)
      return
    }
    const { initialMs, maxMs } = this.options.backoff ?? DEFAULT_BACKOFF
    const delay = Math.min(initialMs * 2 ** this.failures, maxMs)
    this.failures++
    this.options.log.warn(`host: ${reason}; restarting in ${delay} ms`)
    this.options.onLost?.(reason, true)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined
      if (this.stopped || this.gaveUp) return
      this.launch().then(
        (host) => {
          this.failures = 0
          this.options.log.info('host: restarted')
          this.options.onRestart?.(host)
        },
        () => {} // logged in launch; its own loss schedules the next attempt
      )
    }, delay)
  }

  private end(child: HostChild | undefined = this.child): void {
    if (!child) return
    if (child === this.child) {
      this.client?.close()
      this.child = undefined
      this.client = undefined
    }
    if (this.ended.has(child)) return
    this.ended.add(child)
    try {
      ;(this.options.kill ?? ((c: HostChild) => killProcessTree(c, 'SIGTERM')))(child)
    } catch (err) {
      this.options.log.warn(`host: could not end the host process: ${message(err)}`)
    }
  }
}
