// Shared ACP client used by both the Electron main process and the headless probe.
// No Electron imports here on purpose.
import { spawn, type ChildProcess } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import {
  client,
  ndJsonStream,
  PROTOCOL_VERSION,
  type AnyMessage,
  type ClientConnection,
  type InitializeResponse,
  type NewSessionResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type Stream
} from '@agentclientprotocol/sdk'

export type AgentName = 'kiro' | 'claude'

export interface AgentCommand {
  command: string
  args: string[]
}

// `claude` runs the official adapter through npx; `--no-install` resolves the copy in
// ./node_modules so the spike never downloads at runtime (spawn cwd must be the spike root).
export const AGENT_COMMANDS: Record<AgentName, AgentCommand> = {
  kiro: { command: 'kiro-cli', args: ['acp'] },
  claude: { command: 'npx', args: ['--no-install', 'claude-agent-acp'] }
}

export type Direction = 'client->agent' | 'agent->client'

export interface AcpCallbacks {
  onUpdate: (n: SessionNotification) => void
  onPermission: (r: RequestPermissionRequest) => Promise<RequestPermissionResponse>
  onRaw?: (dir: Direction, msg: AnyMessage) => void
  onStderr?: (line: string) => void
  onExit?: (code: number | null) => void
}

export interface StartedAcp {
  init: InitializeResponse
  session: NewSessionResponse
}

export class AcpAgentSession {
  private child!: ChildProcess
  private conn!: ClientConnection
  sessionId = ''
  info!: StartedAcp

  constructor(
    readonly agent: AgentName,
    private readonly spawnCwd: string,
    private readonly cb: AcpCallbacks
  ) {}

  async start(sessionCwd: string): Promise<StartedAcp> {
    const { command, args } = AGENT_COMMANDS[this.agent]
    this.child = spawn(command, args, { cwd: this.spawnCwd, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child.stderr?.setEncoding('utf8')
    this.child.stderr?.on('data', (d: string) =>
      d.split('\n').filter(Boolean).forEach((l) => this.cb.onStderr?.(l))
    )
    this.child.on('exit', (code) => this.cb.onExit?.(code))

    const base = ndJsonStream(
      Writable.toWeb(this.child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(this.child.stdout!) as ReadableStream<Uint8Array>
    )
    this.conn = client({ name: 'workhub2-spike' })
      .onNotification('session/update', (ctx) => this.cb.onUpdate(ctx.params))
      .onRequest('session/request_permission', (ctx) => this.cb.onPermission(ctx.params))
      // Anything not handled above (extension methods, unstable methods) still reaches the log.
      .onRequest('*', () => {
        throw new Error('method not supported by workhub2-spike')
      })
      .onNotification('*', () => {})
      .connect(this.tap(base))

    const init = await this.conn.agent.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'workhub2-spike', version: '0.0.0' }
    })
    // Deliberately EMPTY mcpServers: the point is to see what the agent loads by itself.
    const session = await this.conn.agent.request('session/new', { cwd: sessionCwd, mcpServers: [] })
    this.sessionId = session.sessionId
    this.info = { init, session }
    return this.info
  }

  async prompt(text: string): Promise<string> {
    const res = await this.conn.agent.request('session/prompt', {
      sessionId: this.sessionId,
      prompt: [{ type: 'text', text }]
    })
    return res.stopReason
  }

  async cancel(): Promise<void> {
    await this.conn.agent.notify('session/cancel', { sessionId: this.sessionId })
  }

  async stop(): Promise<void> {
    try {
      this.conn?.close()
    } catch {
      /* already closed */
    }
    const child = this.child
    if (!child || child.exitCode !== null) return
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, 2000)
      child.once('exit', () => {
        clearTimeout(t)
        resolve()
      })
      child.kill('SIGTERM')
    })
  }

  /** Wraps a stream so every JSON-RPC message in both directions is reported to onRaw. */
  private tap(s: Stream): Stream {
    const raw = this.cb.onRaw
    if (!raw) return s
    const readable = s.readable.pipeThrough(
      new TransformStream<AnyMessage, AnyMessage>({
        transform: (m, c) => {
          raw('agent->client', m)
          c.enqueue(m)
        }
      })
    )
    const out = new TransformStream<AnyMessage, AnyMessage>({
      transform: (m, c) => {
        raw('client->agent', m)
        c.enqueue(m)
      }
    })
    void out.readable.pipeTo(s.writable).catch(() => {})
    return { readable, writable: out.writable }
  }
}
