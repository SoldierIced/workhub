import { randomUUID } from 'node:crypto'
import type { RequestPermissionResponse } from '@agentclientprotocol/sdk'
import { AcpAgentSession, type AgentName } from '../shared/acp-client'
import type { AcpEvent, AcpStartResult } from '../shared/api'

/** Owns one ACP agent process at a time and bridges its callbacks to renderer events. */
export class AcpManager {
  private session: AcpAgentSession | null = null
  private pending = new Map<string, (r: RequestPermissionResponse) => void>()

  constructor(
    private spawnCwd: string,
    private emit: (e: AcpEvent) => void
  ) {}

  async start(agent: AgentName, cwd: string): Promise<AcpStartResult> {
    await this.stop()
    const s = new AcpAgentSession(agent, this.spawnCwd, {
      onUpdate: (n) => this.emit({ type: 'update', update: n.update as unknown as Record<string, unknown> }),
      onStderr: (line) => this.emit({ type: 'stderr', line }),
      onExit: (code) => this.emit({ type: 'exit', code }),
      onPermission: (req) =>
        new Promise<RequestPermissionResponse>((resolve) => {
          const requestId = randomUUID()
          this.pending.set(requestId, resolve)
          this.emit({
            type: 'permission',
            requestId,
            title: req.toolCall.title ?? req.toolCall.toolCallId,
            options: req.options.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind }))
          })
        })
    })
    this.session = s
    const { init, session } = await s.start(cwd)
    return {
      sessionId: session.sessionId,
      agentName: init.agentInfo?.title ?? init.agentInfo?.name ?? agent,
      modes: session.modes?.availableModes.map((m) => m.id) ?? [],
      mcpHint: `mcpCapabilities=${JSON.stringify(init.agentCapabilities?.mcpCapabilities ?? {})}`
    }
  }

  prompt(text: string): Promise<string> {
    if (!this.session) throw new Error('no ACP session')
    return this.session.prompt(text)
  }

  async cancel(): Promise<void> {
    await this.session?.cancel()
  }

  respondPermission(requestId: string, optionId: string | null): void {
    const resolve = this.pending.get(requestId)
    if (!resolve) return
    this.pending.delete(requestId)
    resolve(optionId ? { outcome: { outcome: 'selected', optionId } } : { outcome: { outcome: 'cancelled' } })
  }

  async stop(): Promise<void> {
    for (const resolve of this.pending.values()) resolve({ outcome: { outcome: 'cancelled' } })
    this.pending.clear()
    const s = this.session
    this.session = null
    await s?.stop()
  }
}
