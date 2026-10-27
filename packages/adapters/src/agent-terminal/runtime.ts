/**
 * AgentRuntime over a PTY (node-pty; ConPTY on Windows) for any CLI agent or a plain shell.
 * Grown from the P0 spike's `pty-manager.ts`.
 */
import * as nodePty from 'node-pty'
import {
  NO_CAPABILITIES,
  type AgentCapabilities,
  type AgentDefinition,
  type AgentEvent,
  type AgentEventListener,
  type AgentRuntime,
  type PromptResult,
  type StartedSession,
  type StartSessionRequest,
  type TerminalControl,
  type Unsubscribe
} from '@workhub/core'

export interface TerminalRuntimeOptions {
  /** Shell used when an agent has no command. Defaults to $SHELL, else zsh / PowerShell. */
  defaultShell?: string
  /** Injectable for tests. */
  spawn?: typeof nodePty.spawn
}

export function defaultShell(): { command: string; args: string[] } {
  if (process.platform === 'win32') return { command: process.env['COMSPEC'] ?? 'powershell.exe', args: [] }
  // `-l`: login shell, so the user's PATH and profile apply.
  return { command: process.env['SHELL'] ?? '/bin/zsh', args: ['-l'] }
}

export class TerminalRuntime implements AgentRuntime, TerminalControl {
  readonly adapter = 'terminal' as const
  private readonly ptys = new Map<string, nodePty.IPty>()
  private readonly stopping = new Set<string>()
  private readonly listeners = new Set<AgentEventListener>()
  private readonly spawnPty: typeof nodePty.spawn

  constructor(private readonly options: TerminalRuntimeOptions = {}) {
    this.spawnPty = options.spawn ?? nodePty.spawn
  }

  /** A raw terminal: no structured data, whatever the agent could do in app mode. */
  capabilities(_agent: AgentDefinition): AgentCapabilities {
    return { ...NO_CAPABILITIES }
  }

  subscribe(listener: AgentEventListener): Unsubscribe {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async start(req: StartSessionRequest): Promise<StartedSession> {
    const id = req.sessionId
    if (this.ptys.has(id)) throw new Error(`session ${id} already exists`)
    this.emit({ sessionId: id, type: 'state', state: 'starting' })
    const shell = defaultShell()
    const command = req.agent.command.trim() || this.options.defaultShell || shell.command
    const args = req.agent.command.trim() ? req.agent.args : this.options.defaultShell ? [] : shell.args
    let pty: nodePty.IPty
    try {
      pty = this.spawnPty(command, args, {
        name: 'xterm-256color',
        cols: req.cols ?? 80,
        rows: req.rows ?? 24,
        cwd: req.cwd,
        env: { ...(process.env as Record<string, string>), ...req.env }
      })
    } catch (err) {
      const error = `could not start "${command}": ${err instanceof Error ? err.message : String(err)}`
      this.emit({ sessionId: id, type: 'state', state: 'error', error })
      throw new Error(error)
    }
    this.ptys.set(id, pty)
    pty.onData((data) => this.emit({ sessionId: id, type: 'output', data }))
    pty.onExit(({ exitCode }) => {
      this.ptys.delete(id)
      const stopped = this.stopping.delete(id) || exitCode === 0
      this.emit({ sessionId: id, type: 'exit', code: exitCode })
      this.emit({ sessionId: id, type: 'state', state: stopped ? 'stopped' : 'error', error: stopped ? undefined : `exited with code ${exitCode}` })
    })
    this.emit({ sessionId: id, type: 'state', state: 'ready' })
    return {
      agentName: req.agent.name,
      permissionMode: { id: 'unknown', label: 'Not reported (terminal)', source: 'unknown' }
    }
  }

  /** Types the text and presses Enter. */
  async prompt(sessionId: string, text: string): Promise<PromptResult> {
    this.require(sessionId).write(`${text}\r`)
    return { stopReason: 'sent' }
  }

  /** Ctrl-C. */
  async cancel(sessionId: string): Promise<void> {
    this.require(sessionId).write('\x03')
  }

  write(sessionId: string, data: string): void {
    this.ptys.get(sessionId)?.write(data)
  }

  resize(sessionId: string, cols: number, rows: number): void {
    if (cols > 0 && rows > 0) this.ptys.get(sessionId)?.resize(cols, rows)
  }

  respondPermission(): void {
    // Terminal agents ask in the terminal itself.
  }

  async stop(sessionId: string): Promise<void> {
    const pty = this.ptys.get(sessionId)
    if (!pty) return
    this.stopping.add(sessionId)
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          pty.kill('SIGKILL')
        } catch {
          /* gone */
        }
        resolve()
      }, 2000)
      pty.onExit(() => {
        clearTimeout(timer)
        resolve()
      })
      pty.kill()
    })
    this.ptys.delete(sessionId)
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.ptys.keys()].map((id) => this.stop(id)))
  }

  private require(sessionId: string): nodePty.IPty {
    const pty = this.ptys.get(sessionId)
    if (!pty) throw new Error(`no terminal session ${sessionId}`)
    return pty
  }

  private emit(event: AgentEvent): void {
    for (const l of this.listeners) l(event)
  }
}
