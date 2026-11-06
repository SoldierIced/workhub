/**
 * The chat's Listen bridge: summarizes an agent message for listening on the session's Claude
 * account. Arguments are checked here; the renderer is not trusted with shapes.
 */
import { accountAgentId, appOptions, knownAgents, type ListenSummaryResult, type WorkhubConfig } from '@workhub/core'
import type { ListenSummaryRequest } from '@workhub/adapters/listen-summary'
import { claudeConfigDirOf } from './claude-accounts'
import type { IpcRegistrar } from './ipc-guard'

/** Longest message accepted from the renderer; the prompt keeps a much shorter part of it anyway. */
const MAX_TEXT = 200_000

export interface ListenIpcDeps {
  summarize: (request: ListenSummaryRequest) => Promise<ListenSummaryResult>
  config: () => Promise<WorkhubConfig>
  /** The agent and account a session runs with; null for an unknown session. */
  session: (id: string) => { agentId: string; accountId: string | null } | null
  home: string
  env?: NodeJS.ProcessEnv
  /** Where a failed summary is reported; the app passes `main.log`. The renderer only gets the failure kind. */
  log?: (message: string) => void
}

const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200

/**
 * The Claude config folder a summary runs with: the session's own account when it is a Claude
 * account, else Claude's default folder (a Codex or Kiro session has no Claude login of its own).
 * Null when no Claude agent is configured at all.
 */
export function listenConfigDir(config: WorkhubConfig, session: { agentId: string; accountId: string | null } | null, home: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const claude = knownAgents(config).find((a) => a.id === 'claude')
  if (!claude) return null
  const family = accountAgentId(claude)
  const account = session?.accountId ? (config.accounts.find((a) => a.id === session.accountId && a.agentId === family) ?? null) : null
  return claudeConfigDirOf(config, account, home, env)
}

export function registerListenIpc(ipc: IpcRegistrar, deps: ListenIpcDeps): void {
  const running = new Map<string, AbortController>()
  ipc.handle('listen:summarize', async (_e, requestId: unknown, sessionId: unknown, text: unknown): Promise<ListenSummaryResult> => {
    if (!isId(requestId) || !isId(sessionId) || typeof text !== 'string' || !text.trim()) throw new Error('Invalid listen request')
    const config = await deps.config()
    const configDir = listenConfigDir(config, deps.session(sessionId), deps.home, deps.env)
    const log = deps.log ?? ((message: string) => console.warn(message))
    const report = (result: ListenSummaryResult): ListenSummaryResult => {
      if (!result.ok && result.failure !== 'cancelled') log(`listen summary failed (${result.failure}, configDir ${configDir ?? 'none'}): ${result.error}`)
      return result
    }
    if (!configDir) return report({ ok: false, failure: 'noAccount', error: 'No Claude agent is set up.' })
    running.get(requestId)?.abort()
    const controller = new AbortController()
    running.set(requestId, controller)
    try {
      return report(await deps.summarize({ text: text.slice(0, MAX_TEXT), model: appOptions(config).listenModel, configDir, signal: controller.signal }))
    } catch (err) {
      return report({ ok: false, failure: 'failed', error: err instanceof Error ? err.message : String(err) })
    } finally {
      if (running.get(requestId) === controller) running.delete(requestId)
    }
  })
  ipc.on('listen:cancel', (_e, requestId: unknown) => {
    if (isId(requestId)) running.get(requestId)?.abort()
  })
}
