// The `workhub host` process: serves a computer's execution services (agent runtimes, transcripts,
// past sessions, git, file checks) to the app over the host protocol on its stdin and stdout. Plain
// Node only: it runs as Electron-as-Node next to the app, and on a bare Node inside WSL later.
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { parseArgs } from 'node:util'
import { HOST_PROTOCOL_VERSION, type AgentRuntime, type HostHello, type SessionHistorySource, type TranscriptReader } from '@workhub/core'
import type { GitRunner } from '../git-review'
import { augmentedPath, pathKeyOf, refreshLoginPath } from '../shared/login-path'
import { HostChannel } from './channel'
import { composeExecutionServices } from './compose'
import { ControlRelay, HOST_INFO_METHOD, hostSocketDir, hostSocketPath, type HostInfo } from './control-relay'
import { fsHandlers } from './fs'
import { agentRuntimeHandlers, gitRunnerHandlers, historySourceHandlers, transcriptReaderHandlers } from './proxies'
import { HostServer, type HostHandlers } from './server'

/** The services a host serves; ExecutionServices is one. Runtimes are keyed by the id the app asks for. */
export interface HostedServices {
  runtimes: Record<string, AgentRuntime>
  transcripts: TranscriptReader[]
  history: Partial<Record<string, SessionHistorySource>>
  git: GitRunner
}

export interface RunHostOptions {
  /** The protocol's input (the app's requests) and output (hello, responses, events). */
  input: Readable
  output: Writable
  /** This host's build; the app refuses a host whose version is not its own. */
  hostVersion: string
  services: HostedServices
  platform?: NodeJS.Platform
  home?: string
  /** Diagnostics (stderr in the host process: stdout is the protocol). */
  log?: (message: string) => void
  /** Called once, after the runtimes were stopped, when the channel closed or `shutdown` ran. */
  onExit?: (code: number) => void
  /**
   * The Unix socket sessions on this host reach Workhub's control endpoint through (relayed to the
   * app, `control-relay.ts`); `ownedDir` is removed with it. None: sessions here get no endpoint.
   */
  control?: { socketPath: string; ownedDir?: string | null }
  /** The Node this host runs on and its bridge folder, for Workhub's MCP server (`host.info`). */
  node?: string
  bridgeDir?: string
}

export interface RunningHost {
  hello: Omit<HostHello, 't'>
  server: HostServer
  /** Closes the channel, stops every runtime, then calls `onExit`. Resolves once that is done. */
  shutdown(): Promise<void>
}

function helloPlatform(platform: NodeJS.Platform): HostHello['platform'] {
  return platform === 'win32' || platform === 'darwin' ? platform : 'linux'
}

/** Serves `services` over one channel until it closes. */
export function runHost(options: RunHostOptions): RunningHost {
  const { services } = options
  const log = options.log ?? (() => {})
  const platform = options.platform ?? process.platform
  const runtimeIds = Object.keys(services.runtimes)
  const hello: Omit<HostHello, 't'> = {
    protocol: HOST_PROTOCOL_VERSION,
    hostVersion: options.hostVersion,
    features: ['git', 'fs', 'transcripts', 'history', ...(options.control ? ['control'] : []), ...runtimeIds.map((id) => `runtime.${id}`)],
    platform: helloPlatform(platform),
    home: options.home ?? homedir(),
    pathFlavor: platform === 'win32' ? 'win32' : 'posix'
  }
  const channel = new HostChannel(options.input, options.output, { onNotice: (n) => log(`malformed line from the app (${n.reason})`) })
  // Events go through the server once it exists; the runtimes only emit after a session starts.
  let server: HostServer | undefined
  const emit = (event: string, payload?: unknown) => server?.emit(event, payload) ?? false
  const relay = options.control ? new ControlRelay({ emit, log }) : null
  const listening: Promise<string | null> = relay
    ? relay.listen(options.control!.socketPath, options.control!.ownedDir ?? null).then(
        () => relay.socketPath,
        (err: unknown) => {
          log(`the control socket did not start: ${(err as Error).message}; sessions here get no Workhub endpoint`)
          return null
        }
      )
    : Promise.resolve(null)
  const node = options.node ?? process.execPath
  const bridgeDir = options.bridgeDir ?? defaultBridgeDir()
  const handlers: HostHandlers = {
    ...(relay ? relay.handlers : {}),
    [HOST_INFO_METHOD]: async (): Promise<HostInfo> => {
      const socket = await listening
      return { control: socket ? { socket } : null, node, mcpScript: join(bridgeDir, 'workhub-mcp.mjs') }
    },
    ...gitRunnerHandlers(services.git),
    ...fsHandlers(),
    ...transcriptReaderHandlers(services.transcripts),
    ...historySourceHandlers(services.history)
  }
  const disposers: (() => void)[] = []
  for (const id of runtimeIds) {
    const proxied = agentRuntimeHandlers(id, services.runtimes[id]!, emit, { onError: (err) => log(`runtime ${id}: event dropped (${(err as Error).message})`) })
    Object.assign(handlers, proxied.handlers)
    disposers.push(proxied.dispose)
  }
  let stopped: Promise<void> | undefined
  const stop = (): Promise<void> => {
    stopped ??= (async () => {
      relay?.close()
      for (const dispose of disposers) dispose()
      // The same runtime can serve two ids (compose's terminal); stop each once.
      const unique = [...new Set(Object.values(services.runtimes))]
      const results = await Promise.allSettled(unique.map((runtime) => runtime.stopAll()))
      for (const r of results) if (r.status === 'rejected') log(`stopping a runtime failed: ${(r.reason as Error)?.message ?? String(r.reason)}`)
      options.onExit?.(0)
    })()
    return stopped
  }
  channel.onClose((err) => {
    if (err) log(`the channel closed: ${err.message}`)
    void stop()
  })
  server = new HostServer(channel, { hello, handlers, onNotice: (n) => log(`unexpected ${n.t} message from the app`) })
  return {
    hello,
    server,
    shutdown: () => {
      channel.close()
      return stop()
    }
  }
}

/** A payload keeps the Agent SDK bridge (and `workhub-mcp.mjs`) next to the host script. */
const defaultBridgeDir = () => join(dirname(resolve(process.argv[1] ?? '.')), 'bridge')

const USAGE = 'usage: host --stdio [--host-version <v>] [--bridge-dir <dir>] [--fallback-path <dir>]... [--extra-path <dir>]... [--kiro-dir <dir>]'

/**
 * The process entry: parses the arguments, builds this computer's services and serves them on
 * stdin/stdout. Exits when the app closes the channel, or on SIGTERM/SIGINT, stopping agents first.
 */
export function startHost(argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): RunningHost | null {
  // stdout is the protocol: anything printed by this process or a library goes to stderr.
  const toStderr = (...args: unknown[]) => console.error(...args)
  console.log = toStderr
  console.info = toStderr
  console.debug = toStderr
  const log = (message: string) => process.stderr.write(`[host] ${message}\n`)
  let values
  try {
    values = parseArgs({
      args: argv,
      options: {
        stdio: { type: 'boolean' },
        version: { type: 'boolean' },
        'host-version': { type: 'string' },
        'bridge-dir': { type: 'string' },
        'fallback-path': { type: 'string', multiple: true },
        'extra-path': { type: 'string', multiple: true },
        'kiro-dir': { type: 'string' }
      }
    }).values
  } catch (err) {
    log(`${(err as Error).message}\n${USAGE}`)
    process.exitCode = 2
    return null
  }
  const hostVersion = values['host-version'] ?? env['WORKHUB_HOST_VERSION'] ?? '0.0.0-dev'
  if (values.version) {
    process.stdout.write(`${hostVersion}\n`)
    return null
  }
  if (!values.stdio) {
    log(USAGE)
    process.exitCode = 2
    return null
  }
  // The same PATH the app gives sessions: the login shell's, read in the background.
  const launchPath = env[pathKeyOf(env)]
  let cliPath = augmentedPath({ platform: process.platform, inherited: launchPath, loginShell: null })
  if (process.platform !== 'win32') env[pathKeyOf(env)] = cliPath
  void refreshLoginPath(env, launchPath).then((path) => {
    if (path) cliPath = path
  })
  // A payload keeps the Agent SDK bridge next to this script unless told otherwise.
  const bridgeDir = values['bridge-dir'] ?? defaultBridgeDir()
  const services = composeExecutionServices({
    bridgeDir,
    sessionPath: () => (process.platform === 'win32' ? undefined : cliPath),
    fallbackPath: values['fallback-path'] ?? [],
    extraPath: values['extra-path'] ?? [],
    clientVersion: hostVersion,
    kiroDir: values['kiro-dir']
  })
  // Sessions here reach Workhub through a socket of this host (not on Windows: curl cannot use a pipe).
  let control: RunHostOptions['control']
  if (process.platform !== 'win32') {
    try {
      const { dir, created } = hostSocketDir(env)
      control = { socketPath: hostSocketPath(dir), ownedDir: created }
    } catch (err) {
      log(`no folder for the control socket: ${(err as Error).message}`)
    }
  }
  const running = runHost({
    input: process.stdin,
    output: process.stdout,
    hostVersion,
    services,
    control,
    bridgeDir,
    log,
    onExit: (code) => process.exit(code)
  })
  const onSignal = () => void running.shutdown()
  process.once('SIGTERM', onSignal)
  process.once('SIGINT', onSignal)
  return running
}
