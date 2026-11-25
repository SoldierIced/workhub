// The hosts of the WSL distributions profiles name (`profile.host`): one `workhub host` per
// distribution, started through `wsl.exe` on Windows the first time a profile names it, and
// registered as `wsl:<distro>`. The host is installed into the distribution first when this version
// is not there yet (wsl-host-install.ts). Until it connects the sessions of those profiles wait for
// it; when it cannot (no WSL, the install failed) they fail with the reason, never running on this
// computer (hosts.ts). Each step is reported as a
// HostStatusEvent (Settings shows it), and a host that failed can be tried again (`retry`).
import { hostIdOf, joinFlavorPath, nodeArchOfMachine, probeWslDistro, wslHostArgs, wslHostLaunch, type HostLaunch, type HostPayloadArch, type Probe, type ProfileHost, type WslRun } from '@workhub/core'
import type { Logger } from './log-file'
import type { SessionHost } from './hosts'
import type { HostProcessOptions } from './host-process'
import type { HostStatusEvent } from './host-status'
import type { HostInstallProgress } from '../shared/hosts-api'

/** How long a host in WSL gets to say hello: a stopped distribution boots first, which can take a while. */
export const WSL_HELLO_TIMEOUT_MS = 60_000

/**
 * The timeout of the first `wsl.exe` calls into a distribution (the probe, the install's steps): a
 * stopped distribution boots during the first one, and moving a payload folder takes a while too.
 * Never shorter than the hello's.
 */
export const WSL_FIRST_RUN_TIMEOUT_MS = Math.max(120_000, WSL_HELLO_TIMEOUT_MS)

/**
 * Where the host of this version is installed in a distribution (installing it when it is not).
 * `run` is a `wsl.exe` run with the first-call timeout, for its steps.
 */
export type WslHostInstall = (target: { distro: string; home: string; arch: HostPayloadArch; run: WslRun; onProgress: (progress: HostInstallProgress) => void }) => Promise<{ dir: string; nodePath: string; entry: string }>

/** The parts of a HostProcess this uses (faked in tests). */
export interface WslHostProcess {
  connect(): Promise<SessionHost>
  stop(): void
}

export interface WslHostsDeps {
  platform: NodeJS.Platform
  /** The host build this app expects inside the distribution. */
  hostVersion: string
  /** A `wsl.exe` run with the default timeout: the setup check's commands, once the host is installed. */
  run: WslRun
  /** A `wsl.exe` run with this timeout: the probe and the install (`WSL_FIRST_RUN_TIMEOUT_MS`). */
  runner(timeoutMs: number): WslRun
  install: WslHostInstall
  register(host: SessionHost): void
  log: Pick<Logger, 'info' | 'warn' | 'error'>
  /** A HostProcess with these options. */
  createProcess(options: Pick<HostProcessOptions, 'id' | 'launch' | 'hostVersion' | 'onRestart' | 'onLost' | 'helloTimeoutMs'>): WslHostProcess
  /** Where each host is (`wsl:<distro>`), for Settings. */
  status?: (id: string, event: HostStatusEvent) => void
}

/** The `status` detail of a WSL host off Windows. */
export const WSL_NOT_WINDOWS = 'WSL distributions are used only on Windows'

/** The distributions these hosts name, once each, in order. */
export function wslDistrosOf(hosts: Iterable<ProfileHost | undefined>): string[] {
  const out: string[] = []
  for (const h of hosts) if (h?.kind === 'wsl' && !out.includes(h.distro)) out.push(h.distro)
  return out
}

export class WslHosts {
  /** Distributions already asked for (started, starting or failed): each is tried once per run of the app. */
  private readonly asked = new Set<string>()
  /** Distributions whose host failed (could not be read, installed or connected, or was given up on): `retry` starts them again. */
  private readonly failed = new Set<string>()
  private readonly processes = new Map<string, WslHostProcess>()
  /** Where each distribution's host is installed, once it is. */
  private readonly payloads = new Map<string, { dir: string; arch: HostPayloadArch }>()
  private warnedPlatform = false
  private stopped = false

  constructor(private readonly deps: WslHostsDeps) {}

  /** Starts the host of every distribution these profile hosts name that has none yet. */
  ensure(hosts: Iterable<ProfileHost | undefined>): void {
    const distros = wslDistrosOf(hosts).filter((d) => !this.asked.has(d))
    if (distros.length === 0 || this.stopped) return
    if (this.deps.platform !== 'win32') {
      for (const distro of distros) this.report(distro, { type: 'unavailable', detail: WSL_NOT_WINDOWS })
      if (!this.warnedPlatform) this.deps.log.warn(`host: WSL hosts run only on Windows; the sessions of the profiles of ${distros.join(', ')} cannot start`)
      this.warnedPlatform = true
      return
    }
    for (const distro of distros) {
      this.asked.add(distro)
      void this.start(distro)
    }
  }

  /**
   * Starts the host of a distribution that failed again (`wsl:<distro>`), installing it first when
   * it is not there; false for any other id (unknown, starting, connected, or off Windows).
   */
  retry(id: string): boolean {
    const distro = id.startsWith('wsl:') ? id.slice(4) : ''
    if (this.stopped || this.deps.platform !== 'win32' || !this.failed.has(distro)) return false
    this.failed.delete(distro)
    this.processes.get(distro)?.stop()
    this.processes.delete(distro)
    this.deps.log.info(`host ${id}: trying again`)
    void this.start(distro)
    return true
  }

  /**
   * Runs the setup check's commands inside a distribution (read-only): the host's own Claude Code
   * (`claude` is its `--version`, `auth` its `auth status`) and `git --version`. Null until the host
   * of that distribution is installed.
   */
  toolProbe(distro: string): ((tool: 'claude' | 'auth' | 'git') => Promise<Probe>) | null {
    const payload = this.payloads.get(distro)
    if (!payload) return null
    const claude = joinFlavorPath('posix', payload.dir, 'bridge', 'node_modules', '@anthropic-ai', `claude-agent-sdk-linux-${payload.arch}`, 'claude')
    return async (tool) => {
      const command = tool === 'git' ? ['git', '--version'] : [claude, ...(tool === 'auth' ? ['auth', 'status'] : ['--version'])]
      const r = await this.deps.run(['-d', distro, '-e', ...command])
      const output = (r.stdout || r.stderr || '').trim()
      if (r.code === 0) return { result: 'ok', output }
      // wsl.exe -e reports a command the distribution does not have as execvpe(...) failed.
      if (/execvpe|No such file or directory|not found/i.test(output)) return { result: 'notFound', output }
      // The runner ends a run that took too long with -1 (and nothing printed).
      if (r.code === -1 && !output) return { result: 'timeout', output }
      return { result: 'failed', output }
    }
  }

  /** Ends every host process (the app quits). */
  stop(): void {
    this.stopped = true
    for (const p of this.processes.values()) p.stop()
    this.processes.clear()
  }

  private report(distro: string, event: HostStatusEvent): void {
    this.deps.status?.(hostIdOf({ kind: 'wsl', distro }), event)
  }

  private fail(distro: string, detail: string): void {
    this.failed.add(distro)
    this.report(distro, { type: 'failed', detail })
  }

  private async start(distro: string): Promise<void> {
    const id = hostIdOf({ kind: 'wsl', distro })
    const fallback = 'the sessions of its profiles cannot start'
    let launch: HostLaunch
    let dir: string
    let home: string
    this.report(distro, { type: 'connecting' })
    try {
      // The first call into the distribution, which may have to boot it first.
      const run = this.deps.runner(WSL_FIRST_RUN_TIMEOUT_MS)
      const info = await probeWslDistro(run, distro)
      home = info.home
      const arch = nodeArchOfMachine(info.arch)
      if (!arch) throw new Error(`no host is built for its processor (${info.arch})`)
      const payload = await this.deps.install({ distro, home: info.home, arch, run, onProgress: (progress) => this.report(distro, { type: 'installing', progress }) })
      dir = payload.dir
      this.payloads.set(distro, { dir, arch })
      launch = wslHostLaunch({ distro, nodePath: payload.nodePath, entry: payload.entry, hostVersion: this.deps.hostVersion, args: wslHostArgs(payload.dir, arch) })
    } catch (err) {
      this.deps.log.error(`host ${id}: ${message(err)}; ${fallback}`)
      this.fail(distro, message(err))
      return
    }
    if (this.stopped) return
    // An install is over: the host starts (a cold distribution can take a while to say hello).
    this.report(distro, { type: 'connecting' })
    const hostProcess = this.deps.createProcess({
      id,
      hostVersion: this.deps.hostVersion,
      launch: () => launch,
      onRestart: (restarted) => {
        const host = { ...restarted, home }
        this.deps.register(host)
        this.report(distro, { type: 'connected', control: host.control !== null })
      },
      onLost: (reason, restarting) => {
        if (restarting) this.report(distro, { type: 'lost', reason, restarting })
        else this.fail(distro, reason)
      },
      helloTimeoutMs: WSL_HELLO_TIMEOUT_MS
    })
    this.processes.set(distro, hostProcess)
    try {
      const host = { ...(await hostProcess.connect()), home }
      if (this.stopped) return
      this.deps.register(host)
      this.report(distro, { type: 'connected', control: host.control !== null })
      if (host.control === null) this.deps.log.warn(`host ${id}: connected without a control endpoint; its sessions cannot reach Workhub's MCP server`)
      this.deps.log.info(`host ${id}: connected; its profiles' sessions run in ${distro}`)
    } catch (err) {
      this.deps.log.error(`host ${id}: not available (the host is expected at ${dir}): ${message(err)}; ${fallback}`)
      if (this.processes.get(distro) === hostProcess) this.processes.delete(distro)
      hostProcess.stop()
      this.fail(distro, message(err))
    }
  }
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))
