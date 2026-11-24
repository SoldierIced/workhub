/**
 * The chat's Listen bridge: summarizes an agent message for listening on the session's Claude
 * account. Arguments are checked here; the renderer is not trusted with shapes.
 */
import { accountAgentId, appOptions, knownAgents, type ListenSummaryResult, type WorkhubConfig } from '@workhub/core'
import type { ListenSummaryRequest } from '@workhub/adapters/listen-summary'
import { claudeLaunchDir, type ClaudeLaunchDir } from './claude-accounts'
import type { BackgroundUsage } from './background-usage'
import type { IpcRegistrar } from './ipc-guard'

/** Longest message accepted from the renderer; the prompt keeps a much shorter part of it anyway. */
const MAX_TEXT = 200_000

export interface ListenIpcDeps {
  summarize: (request: ListenSummaryRequest) => Promise<ListenSummaryResult>
  config: () => Promise<WorkhubConfig>
  /** The agent and account a session runs with; null for an unknown session. */
  session: (id: string) => { agentId: string; accountId: string | null } | null
  home: string
  /** Where a failed summary is reported; the app passes `main.log`. The renderer only gets the failure kind. */
  log?: (message: string) => void
  /** Each summary is a model run on the account: its tokens and cost go to the usage data ("Workhub background"). */
  background?: Pick<BackgroundUsage, 'record'>
  now?: () => number
}

const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200

/**
 * The Claude folder a summary names: the session's own account when it is a Claude account, else
 * Claude's default account (a Codex or Kiro session has no Claude login of its own). `default`
 * names no folder; `noClaude` when no Claude agent is configured at all.
 */
export function listenConfigDir(config: WorkhubConfig, session: { agentId: string; accountId: string | null } | null): ClaudeLaunchDir {
  return claudeLaunchDir(config, listenAccount(config, session))
}

/** The session's own Claude account, when it runs on one; null for the default folder. */
function listenAccount(config: WorkhubConfig, session: { agentId: string; accountId: string | null } | null): WorkhubConfig['accounts'][number] | null {
  const claude = knownAgents(config).find((a) => a.id === 'claude')
  if (!claude || !session?.accountId) return null
  const family = accountAgentId(claude)
  return config.accounts.find((a) => a.id === session.accountId && a.agentId === family) ?? null
}

export function registerListenIpc(ipc: IpcRegistrar, deps: ListenIpcDeps): void {
  const running = new Map<string, AbortController>()
  ipc.handle('listen:summarize', async (_e, requestId: unknown, sessionId: unknown, text: unknown): Promise<ListenSummaryResult> => {
    if (!isId(requestId) || !isId(sessionId) || typeof text !== 'string' || !text.trim()) throw new Error('Invalid listen request')
    const config = await deps.config()
    const session = deps.session(sessionId)
    const launch = listenConfigDir(config, session)
    const configDir = launch.kind === 'named' ? launch.dir : undefined
    const log = deps.log ?? ((message: string) => console.warn(message))
    const report = (result: ListenSummaryResult): ListenSummaryResult => {
      if (!result.ok && result.failure !== 'cancelled') log(`listen summary failed (${result.failure}, configDir ${launch.kind === 'named' ? 'named' : 'default'}): ${result.error}`)
      return result
    }
    if (launch.kind === 'noClaude') return report({ ok: false, failure: 'noAccount', error: 'No Claude agent is set up.' })
    running.get(requestId)?.abort()
    const controller = new AbortController()
    running.set(requestId, controller)
    const now = deps.now ?? Date.now
    const started = now()
    try {
      const { listenModel: model, prompts } = appOptions(config)
      const result = await deps.summarize({ text: text.slice(0, MAX_TEXT), model, ...(prompts ? { prompts } : {}), ...(configDir ? { configDir } : {}), signal: controller.signal })
      // A run that reported nothing (cancelled before it started, no helper answer) spent nothing known.
      if (result.usage || result.costUsd !== undefined) {
        deps.background?.record({
          kind: 'listenSummary',
          accountId: listenAccount(config, session)?.id ?? null,
          at: started,
          durationMs: now() - started,
          ...(result.usage ? { usage: result.usage } : {}),
          ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
          ...(model ? { model } : {})
        })
      }
      return report(result)
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
