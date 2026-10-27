/**
 * Maps ACP traffic into the common session monitor model. Pure (no I/O) so it can be tested
 * against recorded fixtures. Every reader is defensive: unknown or malformed data is skipped.
 *
 * Standard ACP: `session_info_update` (title), `usage_update` (context window, cost, model),
 * `tool_call` / `tool_call_update`, and the `usage` of a `session/prompt` result.
 * Kiro extensions (`_kiro.dev/*`, Kiro 2.33): `commands/available` (MCP servers with status and
 * tool count), `mcp/server_initialized`, `mcp/oauth_request`, `metadata` (context %, credits per
 * turn, turn duration), `subagent/list_update`.
 */
import {
  isUnattendedMode,
  type McpServerState,
  type McpServerStatus,
  type ModelOption,
  type ModeSemantics,
  type PermissionModeInfo,
  type SessionModeOption,
  type SessionMonitorSnapshot,
  type SubagentSummary,
  type ToolCallSummary
} from '@workhub/core'

type Obj = Record<string, unknown>

const obj = (v: unknown): Obj | undefined => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

function serverState(status: string | undefined): McpServerState {
  switch (status) {
    case 'running':
    case 'loading':
    case 'failed':
      return status
    case 'error':
      return 'failed'
    default:
      return 'unknown'
  }
}

/** Accumulates one session's monitor data. Each `apply*` returns the changed fields, or null. */
export class AcpMonitor {
  private snapshot: SessionMonitorSnapshot = {}
  private readonly servers = new Map<string, McpServerStatus>()
  private readonly tools = new Map<string, ToolCallSummary>()

  current(): SessionMonitorSnapshot {
    return this.snapshot
  }

  /** A `session/update` notification's `update` object. */
  applyUpdate(update: unknown): SessionMonitorSnapshot | null {
    const u = obj(update)
    if (!u) return null
    switch (u['sessionUpdate']) {
      case 'session_info_update': {
        const title = str(u['title'])
        return title ? this.patch({ title }) : null
      }
      case 'usage_update': {
        const used = num(u['used'])
        const size = num(u['size'])
        const patch: SessionMonitorSnapshot = {}
        if (used !== undefined || size !== undefined) {
          patch.context = { ...this.snapshot.context, used, size }
          if (used !== undefined && size) patch.context.percent = (used / size) * 100
        }
        const cost = obj(u['cost'])
        const amount = num(cost?.['amount'])
        if (amount !== undefined) patch.cost = { amount, currency: str(cost?.['currency']) ?? 'USD' }
        const model = str(obj(u['_meta'])?.['_claude/model'])
        if (model) patch.model = model
        return Object.keys(patch).length ? this.patch(patch) : null
      }
      case 'tool_call':
      case 'tool_call_update': {
        const id = str(u['toolCallId'])
        if (!id) return null
        const prev = this.tools.get(id)
        const next: ToolCallSummary = {
          id,
          title: str(u['title']) ?? prev?.title ?? id,
          kind: str(u['kind']) ?? prev?.kind,
          status: str(u['status']) ?? prev?.status
        }
        this.tools.set(id, next)
        return this.patch({ toolCalls: [...this.tools.values()] })
      }
      default:
        return null
    }
  }

  /**
   * A turn that ended without `end_turn` (cancelled, refused, out of tokens): its tool calls still
   * pending or running will never finish, so they are marked cancelled, as ACP asks of the client.
   */
  endTurn(stopReason: string): SessionMonitorSnapshot | null {
    if (stopReason === 'end_turn') return null
    let changed = false
    for (const [id, t] of this.tools) {
      if (t.status !== 'pending' && t.status !== 'in_progress') continue
      this.tools.set(id, { ...t, status: 'cancelled' })
      changed = true
    }
    return changed ? this.patch({ toolCalls: [...this.tools.values()] }) : null
  }

  /** The result of `session/prompt`. Token counts are summed over the session's turns. */
  applyPromptResult(result: unknown): SessionMonitorSnapshot | null {
    const usage = obj(obj(result)?.['usage'])
    if (!usage) return null
    const prev = this.snapshot.tokens ?? {}
    const add = (a: number | undefined, b: unknown) => (num(b) === undefined ? a : (a ?? 0) + (b as number))
    return this.patch({
      tokens: {
        input: add(prev.input, usage['inputTokens']),
        output: add(prev.output, usage['outputTokens']),
        cacheRead: add(prev.cacheRead, usage['cachedReadTokens']),
        cacheWrite: add(prev.cacheWrite, usage['cachedWriteTokens']),
        total: add(prev.total, usage['totalTokens'])
      }
    })
  }

  /** An extension notification (method starting with `_`). */
  applyExtension(method: string, params: unknown): SessionMonitorSnapshot | null {
    const p = obj(params)
    if (!p) return null
    switch (method) {
      case '_kiro.dev/commands/available': {
        if (!Array.isArray(p['mcpServers'])) return null
        const seen = new Set<string>()
        for (const raw of arr(p['mcpServers'])) {
          const s = obj(raw)
          const name = str(s?.['name'])
          if (!name) continue
          seen.add(name)
          let state = serverState(str(s?.['status']))
          // A server waiting for OAuth reports `loading`; keep the more useful `needs-auth`.
          if (state === 'loading' && this.servers.get(name)?.state === 'needs-auth') state = 'needs-auth'
          this.servers.set(name, { name, state, toolCount: num(s?.['toolCount']) })
        }
        for (const name of [...this.servers.keys()]) if (!seen.has(name)) this.servers.delete(name)
        return this.patchServers()
      }
      case '_kiro.dev/mcp/server_initialized': {
        const name = str(p['serverName'])
        if (!name) return null
        this.servers.set(name, { ...this.servers.get(name), name, state: 'running' })
        return this.patchServers()
      }
      case '_kiro.dev/mcp/oauth_request': {
        // The OAuth URL is deliberately not kept: it carries PKCE state.
        const name = str(p['serverName'])
        if (!name) return null
        const prev = this.servers.get(name)
        if (prev?.state === 'running') return null
        this.servers.set(name, { ...prev, name, state: 'needs-auth' })
        return this.patchServers()
      }
      case '_kiro.dev/metadata': {
        const patch: SessionMonitorSnapshot = {}
        const percent = num(p['contextUsagePercentage'])
        if (percent !== undefined) patch.context = { ...this.snapshot.context, percent }
        const credits = arr(p['meteringUsage'])
          .map(obj)
          .filter((m) => m && str(m['unit']) === 'credit')
          .reduce<number | undefined>((sum, m) => (num(m?.['value']) === undefined ? sum : (sum ?? 0) + (m!['value'] as number)), undefined)
        if (credits !== undefined) {
          patch.lastTurnCredits = credits
          patch.credits = (this.snapshot.credits ?? 0) + credits
          patch.turnCredits = [...(this.snapshot.turnCredits ?? []), credits]
        }
        const turnMs = num(p['turnDurationMs'])
        if (turnMs !== undefined) patch.activeTimeMs = (this.snapshot.activeTimeMs ?? 0) + turnMs
        return Object.keys(patch).length ? this.patch(patch) : null
      }
      case '_kiro.dev/subagent/list_update': {
        if (!Array.isArray(p['subagents'])) return null
        const subagents: SubagentSummary[] = arr(p['subagents']).map((raw, i) => {
          const s = obj(raw) ?? {}
          return {
            id: str(s['id']) ?? str(s['sessionId']) ?? str(s['name']) ?? String(i),
            name: str(s['name']) ?? str(s['agentName']),
            status: str(s['status'])
          }
        })
        return this.patch({ subagents })
      }
      default:
        return null
    }
  }

  private patchServers(): SessionMonitorSnapshot {
    return this.patch({ mcpServers: [...this.servers.values()] })
  }

  private patch(p: SessionMonitorSnapshot): SessionMonitorSnapshot {
    this.snapshot = { ...this.snapshot, ...p }
    return p
  }
}

export interface ModeState {
  permissionMode: PermissionModeInfo
  currentModeId?: string
  availableModes?: SessionModeOption[]
}

/**
 * How a session's model or mode is switched: the dedicated ACP method (`session/set_model`,
 * `session/set_mode`), or a session config option (`session/set_config_option`, the newer ACP
 * form some adapters use instead, e.g. claude-agent-acp).
 */
export type SelectVia = { kind: 'method' } | { kind: 'config'; configId: string }

interface ConfigSelect {
  configId: string
  currentValue?: string
  options: { id: string; name: string; description?: string }[]
}

/** The first `select` config option of a category (`model`, `mode`) in `configOptions`. */
export function readConfigSelect(configOptions: unknown, category: string): ConfigSelect | undefined {
  for (const raw of arr(configOptions)) {
    const o = obj(raw)
    if (!o || o['type'] !== 'select' || o['category'] !== category) continue
    // ACP v1 names it `id`; the v2 draft `configId`.
    const configId = str(o['id']) ?? str(o['configId'])
    if (!configId) continue
    // Options are either a flat list or groups of options.
    const flat = arr(o['options']).flatMap((x) => {
      const g = obj(x)
      return g && Array.isArray(g['options']) ? arr(g['options']) : [x]
    })
    const options = flat.flatMap((x) => {
      const v = obj(x)
      const id = str(v?.['value'])
      return id ? [{ id, name: str(v?.['name']) ?? id, description: str(v?.['description']) }] : []
    })
    return { configId, currentValue: str(o['currentValue']), options }
  }
  return undefined
}

const withoutEmpty = <T extends { description?: string }>(o: T): T => {
  if (o.description === undefined) delete o.description
  return o
}

/**
 * Reads ACP `modes` (`{currentModeId, availableModes}`) from a `session/new` response, or the
 * `mode` config option when the agent reports modes that way.
 */
export function readModes(session: unknown): { currentModeId?: string; availableModes: SessionModeOption[]; via?: SelectVia } {
  const s = obj(session)
  const modes = obj(s?.['modes'])
  const availableModes = arr(modes?.['availableModes']).flatMap((raw) => {
    const m = obj(raw)
    const id = str(m?.['id'])
    return id ? [{ id, name: str(m?.['name']) ?? id, description: str(m?.['description']) }] : []
  })
  if (availableModes.length || modes) return { currentModeId: str(modes?.['currentModeId']), availableModes, ...(availableModes.length ? { via: { kind: 'method' } as const } : {}) }
  const config = readConfigSelect(s?.['configOptions'], 'mode')
  if (config?.options.length) {
    return { currentModeId: config.currentValue, availableModes: config.options.map((o) => withoutEmpty({ ...o })), via: { kind: 'config', configId: config.configId } }
  }
  return { currentModeId: undefined, availableModes: [] }
}

/**
 * Reads ACP `models` (`{currentModelId, availableModels: [{modelId, name, description}]}`, the
 * unstable session model state Kiro and OpenCode report) from a `session/new` response, or the
 * `model` config option.
 */
export function readModels(session: unknown): { currentModelId?: string; availableModels: ModelOption[]; via?: SelectVia } {
  const s = obj(session)
  const models = obj(s?.['models'])
  const availableModels = arr(models?.['availableModels']).flatMap((raw) => {
    const m = obj(raw)
    const id = str(m?.['modelId']) ?? str(m?.['id'])
    return id ? [withoutEmpty({ id, name: str(m?.['name']) ?? id, description: str(m?.['description']) })] : []
  })
  if (availableModels.length) return { currentModelId: str(models?.['currentModelId']), availableModels, via: { kind: 'method' } }
  const config = readConfigSelect(s?.['configOptions'], 'model')
  if (config?.options.length) {
    return { currentModelId: config.currentValue, availableModels: config.options.map((o) => withoutEmpty({ ...o })), via: { kind: 'config', configId: config.configId } }
  }
  return { currentModelId: str(models?.['currentModelId']), availableModels: [] }
}

/**
 * The effective permission mode, from the agent's current mode and what its modes mean.
 * Permission modes (Claude) are shown as-is; personas (Kiro) set their own tool trust, which ACP
 * does not expose, so the mode is reported as managed by the agent.
 */
export function permissionMode(
  semantics: ModeSemantics,
  currentModeId: string | undefined,
  availableModes: SessionModeOption[]
): PermissionModeInfo {
  if (semantics === 'permission' && currentModeId) {
    const name = availableModes.find((m) => m.id === currentModeId)?.name ?? currentModeId
    return { id: currentModeId, label: name, source: 'agent', unattended: isUnattendedMode(currentModeId) }
  }
  if (semantics === 'persona') {
    return {
      id: 'agent-managed',
      label: currentModeId ? `Set by agent "${currentModeId}"` : 'Set by the agent',
      source: 'agent'
    }
  }
  return { id: 'unknown', label: 'Not reported by the agent', source: 'unknown' }
}
