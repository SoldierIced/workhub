// Types of the preload bridge (window.hub). Shared by main, preload and renderer.
import type { AgentName } from './acp-client'

export type { AgentName }

export interface PtyApi {
  start(cwd: string, cols: number, rows: number): Promise<number>
  write(id: number, data: string): void
  resize(id: number, cols: number, rows: number): void
  kill(id: number): void
  onData(cb: (id: number, data: string) => void): () => void
  onExit(cb: (id: number, code: number) => void): () => void
}

export interface PermissionOptionView {
  optionId: string
  name: string
  kind: string
}

export type AcpEvent =
  | { type: 'update'; update: Record<string, unknown> }
  | {
      type: 'permission'
      requestId: string
      title: string
      options: PermissionOptionView[]
    }
  | { type: 'stderr'; line: string }
  | { type: 'exit'; code: number | null }

export interface AcpStartResult {
  sessionId: string
  agentName: string
  modes: string[]
  mcpHint: string
}

export interface AcpApi {
  start(agent: AgentName, cwd: string): Promise<AcpStartResult>
  prompt(text: string): Promise<string>
  cancel(): Promise<void>
  stop(): Promise<void>
  respondPermission(requestId: string, optionId: string | null): void
  onEvent(cb: (e: AcpEvent) => void): () => void
}

export interface HubApi {
  getDefaultCwd(): Promise<string>
  pickFolder(): Promise<string | null>
  pty: PtyApi
  acp: AcpApi
}
