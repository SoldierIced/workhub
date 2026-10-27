import { accountAgent, type AgentDefinition, type AgentAccount, type ModelOption, type SessionModeOption } from '@workhub/core'
import type { AgentOptions } from '@workhub/adapters/agent-acp'
import type { AgentOptionsView } from '../shared/api'

/** One remembered reading of an agent's models and modes, per agent key. */
export interface StoredAgentOptions {
  models: ModelOption[]
  modes: SessionModeOption[]
  defaultModelId?: string
  defaultModeId?: string
  source: 'cli' | 'session'
  at: number
}

export type AgentOptionsState = Record<string, StoredAgentOptions>

export interface AgentOptionsDeps {
  /** Lists what an agent offers through its own CLI (Kiro); null for agents without such a command. */
  discover: (agent: AgentDefinition) => Promise<AgentOptions> | null
  state: { load(fallback: AgentOptionsState): AgentOptionsState; save(state: AgentOptionsState): void }
  now?: () => number
  /** How long a CLI listing is reused before it is run again (default 10 min). */
  maxAgeMs?: number
}

/** The key options are kept under: the account's when it has one (another build, another login), else the agent's. */
export function optionsKey(agentId: string, accountId: string | null): string {
  return accountId ? `${agentId}:${accountId}` : agentId
}

const cleanList = <T extends { id: string; name: string; description?: string }>(list: unknown): T[] =>
  Array.isArray(list)
    ? (list.filter((x) => x && typeof x === 'object' && typeof (x as T).id === 'string' && typeof (x as T).name === 'string').slice(0, 500) as T[])
    : []

/** A state file from disk, kept only where it has the expected shape. */
export function parseAgentOptionsState(raw: unknown): AgentOptionsState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: AgentOptionsState = {}
  for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
    const o = v as Partial<StoredAgentOptions> | null
    if (!o || typeof o !== 'object' || typeof o.at !== 'number' || (o.source !== 'cli' && o.source !== 'session')) continue
    out[key] = {
      models: cleanList<ModelOption>(o.models),
      modes: cleanList<SessionModeOption>(o.modes),
      ...(typeof o.defaultModelId === 'string' ? { defaultModelId: o.defaultModelId } : {}),
      ...(typeof o.defaultModeId === 'string' ? { defaultModeId: o.defaultModeId } : {}),
      source: o.source,
      at: o.at
    }
  }
  return out
}

/**
 * What each agent offers before a session starts (models, modes), for the New session dialog and
 * Settings. Kiro lists its models and agents through its CLI (`kiro-cli chat --list-models`,
 * `kiro-cli agent list`); every ACP agent's sessions report theirs at start, which is kept for the
 * next time. Stored in the data folder so it survives restarts.
 */
export class AgentOptionsService {
  private state: AgentOptionsState
  private readonly inflight = new Map<string, Promise<StoredAgentOptions | null>>()

  constructor(private readonly deps: AgentOptionsDeps) {
    this.state = parseAgentOptionsState(deps.state.load({}))
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /** A session reported its models and modes. A fresher CLI listing keeps its defaults. */
  record(agentId: string, accountId: string | null, options: { models: ModelOption[]; modes: SessionModeOption[] }): void {
    if (!options.models.length && !options.modes.length) return
    const key = optionsKey(agentId, accountId)
    const prev = this.state[key]
    const next: StoredAgentOptions = {
      ...(prev ?? {}),
      models: options.models.length ? options.models : (prev?.models ?? []),
      modes: options.modes.length ? options.modes : (prev?.modes ?? []),
      source: 'session',
      at: this.now()
    }
    // The agent's own default is whatever its CLI says; a session only says what it started with.
    this.state = { ...this.state, [key]: next }
    this.deps.state.save(this.state)
  }

  async get(agent: AgentDefinition, account: AgentAccount | null, refresh = false): Promise<AgentOptionsView> {
    const key = optionsKey(agent.id, account?.id ?? null)
    let stored = this.state[key] ?? (account ? this.state[optionsKey(agent.id, null)] : undefined)
    const maxAge = this.deps.maxAgeMs ?? 10 * 60_000
    const stale = !stored || stored.source !== 'cli' || this.now() - stored.at > maxAge
    if (refresh || stale) stored = (await this.discover(key, accountAgent(agent, account))) ?? stored
    if (!stored) return { models: [], modes: [], source: 'none', modeSemantics: agent.modeSemantics }
    const { models, modes, defaultModelId, defaultModeId, source, at } = stored
    return { models, modes, ...(defaultModelId ? { defaultModelId } : {}), ...(defaultModeId ? { defaultModeId } : {}), source, at, modeSemantics: agent.modeSemantics }
  }

  /** Runs the agent's listing commands once at a time per key; nothing found keeps the last reading. */
  private discover(key: string, agent: AgentDefinition): Promise<StoredAgentOptions | null> {
    const running = this.inflight.get(key)
    if (running) return running
    const listing = this.deps.discover(agent)
    if (!listing) return Promise.resolve(null)
    const task = listing
      .then((found): StoredAgentOptions | null => {
        if (!found.models.length && !found.modes.length) return null
        const next: StoredAgentOptions = {
          models: found.models,
          modes: found.modes,
          ...(found.defaultModelId ? { defaultModelId: found.defaultModelId } : {}),
          ...(found.defaultModeId ? { defaultModeId: found.defaultModeId } : {}),
          source: 'cli',
          at: this.now()
        }
        this.state = { ...this.state, [key]: next }
        this.deps.state.save(this.state)
        return next
      })
      .catch(() => null)
      .finally(() => this.inflight.delete(key))
    this.inflight.set(key, task)
    return task
  }
}

/** Whether an agent runs the Kiro CLI (the built-in Kiro, an account's own build, or a user agent), so its listing commands apply. */
export function runsKiroCli(agent: Pick<AgentDefinition, 'command'>): boolean {
  return /(^|[\\/])kiro-cli(\.exe)?$/i.test(agent.command.trim())
}
