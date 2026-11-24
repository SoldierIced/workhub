import { agentAvailability } from '@workhub/adapters/agent-acp'
import { hostAgentAvailability, knownAgents, setSessionCeiling, type AgentAvailability, type ConfigurationService, type CreditSpend, type SessionCeilings, type WorkhubConfig } from '@workhub/core'
import type { AgentOptionsService } from '../agent-options'
import type { AgentUsageService } from '../agent-usage'
import type { ApiSpendService } from '../api-spend'
import type { IpcRegistrar } from '../ipc-guard'
import { resolveChoice } from '../session-manager'
import type { TokenSpendService } from '../token-spend'

/** Only windows with a valid ceiling (1-100) from what the renderer sent. */
function cleanSessionCeilings(raw: unknown): SessionCeilings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  let out: SessionCeilings = {}
  for (const [window, value] of Object.entries(raw)) if (typeof value === 'number') out = setSessionCeiling(out, window, value)
  return out
}

export interface UsageIpcDeps {
  configuration: ConfigurationService
  /** Agent adapters installed with the app, found through PATH. */
  extraPath: string[]
  /** The PATH agents start with, plus the bundled Claude Code. */
  agentPath: () => string
  /** The WSL distribution a profile runs in and whether its host has connected; null on this computer. */
  wslHost?: (config: WorkhubConfig, profileId: string) => { distro: string; connected: boolean } | null
  agentOptions: AgentOptionsService
  usage: AgentUsageService
  kiroSpend: () => Promise<CreditSpend | null>
  apiSpend: Pick<ApiSpendService, 'summary'>
  tokenSpend: Pick<TokenSpendService, 'forProfile'>
  /** Each session's own usage ceilings, by session identity. */
  sessionBudgets: { load(fallback: Record<string, SessionCeilings>): Record<string, SessionCeilings>; save(value: Record<string, SessionCeilings>): void; flush(): void }
  send: (channel: string, ...message: unknown[]) => void
  showUsageNotification: (n: { title: string; body: string }) => void
  /** The renderer listens for usage alerts: the ones found before go out now. */
  alertsReady: () => void
}

/** Agents' availability and options, plan usage, spend and session ceilings (`agents:*`, `usage:*`). */
export function registerUsageIpc(ipc: IpcRegistrar, deps: UsageIpcDeps): void {
  const { configuration, agentOptions, usage, sessionBudgets, send } = deps
  // A profile in WSL offers what runs there (Claude Code, once its host is up), not what this computer has.
  ipc.handle('agents:availability', async (_e, profileId?: unknown): Promise<Record<string, AgentAvailability>> => {
    const config = await configuration.current()
    const wsl = typeof profileId === 'string' ? deps.wslHost?.(config, profileId) : null
    if (wsl) return hostAgentAvailability(knownAgents(config), wsl.connected)
    return agentAvailability(knownAgents(config), {
      extraPath: deps.extraPath,
      path: deps.agentPath()
    })
  })
  ipc.handle('agents:options', async (_e, agentKey: string, refresh?: boolean) => {
    const config = await configuration.current()
    const choice = typeof agentKey === 'string' ? resolveChoice(config, config.activeProfileId ?? null, agentKey) : null
    if (!choice) return { models: [], modes: [], source: 'none', modeSemantics: 'none' }
    return agentOptions.get(choice.agent, choice.account, refresh === true)
  })
  ipc.handle('usage:get', (_e, refresh?: boolean) => (refresh ? usage.refresh() : usage.current()))
  ipc.handle('usage:refreshNow', () => usage.refresh({ force: true }))
  ipc.handle('usage:kiroSpend', () => deps.kiroSpend())
  ipc.handle('usage:apiSpend', () => deps.apiSpend.summary())
  ipc.handle('usage:folderSpend', (_e, profileId?: string | null) => deps.tokenSpend.forProfile(typeof profileId === 'string' ? profileId : null))
  ipc.handle('usage:sessionBudgets', () => sessionBudgets.load({}))
  ipc.handle('usage:setSessionBudget', (_e, identity: unknown, ceilings: unknown) => {
    if (typeof identity !== 'string' || !identity) return
    const all = sessionBudgets.load({})
    const own = cleanSessionCeilings(ceilings)
    if (Object.keys(own).length) all[identity] = own
    else delete all[identity]
    // `load` merges over the fallback, so a removed entry must be written as a whole new object.
    sessionBudgets.save({ ...all })
    sessionBudgets.flush()
    send('usage:sessionBudgetsChanged', all)
  })
  ipc.on('usage:notify', (_e, n: { title: string; body: string }) => deps.showUsageNotification(n))
  ipc.on('usage:ready', () => deps.alertsReady())
}
