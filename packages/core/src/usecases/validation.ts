import { isValidEnvName, type AgentDefinition } from '../domain/agent'
import { BUILTIN_AGENTS } from '../domain/builtin-agents'
import { CONNECTION_KINDS, findProvider } from '../domain/connection'
import type { WorkhubConfig } from '../config/schema'

export interface ValidationIssue {
  /** Dotted path of the offending value, e.g. `profiles.work.connections.tracker`. */
  path: string
  message: string
}

export type Result<T> = { ok: true; value: T } | { ok: false; issues: ValidationIssue[] }

export const ok = <T>(value: T): Result<T> => ({ ok: true, value })
export const fail = <T = never>(issues: ValidationIssue[]): Result<T> => ({ ok: false, issues })

/** Built-in agents overlaid with the user's agents (same id replaces). */
export function knownAgents(config: Pick<WorkhubConfig, 'agents'>): AgentDefinition[] {
  const byId = new Map<string, AgentDefinition>(BUILTIN_AGENTS.map((a) => [a.id, a]))
  for (const a of config.agents) byId.set(a.id, { ...a, builtIn: false })
  return [...byId.values()]
}

function duplicates(ids: string[]): string[] {
  const seen = new Set<string>()
  const dup = new Set<string>()
  for (const i of ids) (seen.has(i) ? dup : seen).add(i)
  return [...dup]
}

// `URL` is not in the ES lib core compiles against (no DOM, no Node), so a strict pattern is used.
const HTTP_URL = /^https?:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?(\/[^\s]*)?$/i

function isUrl(value: string): boolean {
  return HTTP_URL.test(value)
}

function checkEnv(env: Record<string, string> | undefined, path: string, issues: ValidationIssue[]): void {
  for (const name of Object.keys(env ?? {})) {
    if (!isValidEnvName(name)) issues.push({ path: `${path}.${name}`, message: 'not a valid environment variable name' })
  }
}

/**
 * Cross-reference rules the schema cannot express: unique ids, providers that exist and match
 * the connection kind, endpoint and secret where the provider needs them, and profiles that
 * only reference existing connections of the right kind and existing accounts and agents.
 */
export function validateConfig(config: WorkhubConfig): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  for (const [list, items] of [
    ['connections', config.connections],
    ['agents', config.agents],
    ['accounts', config.accounts],
    ['profiles', config.profiles]
  ] as const) {
    for (const d of duplicates(items.map((i) => i.id))) issues.push({ path: `${list}.${d}`, message: 'duplicate id' })
  }

  for (const c of config.connections) {
    const path = `connections.${c.id}`
    const provider = findProvider(c.provider)
    if (!provider) {
      issues.push({ path: `${path}.provider`, message: `unknown provider "${c.provider}"` })
      continue
    }
    if (provider.kind !== c.kind) {
      issues.push({ path: `${path}.provider`, message: `provider "${c.provider}" is a ${provider.kind} provider, not ${c.kind}` })
    }
    const endpoint = c.endpoint?.trim()
    if (provider.requiresEndpoint && !endpoint) issues.push({ path: `${path}.endpoint`, message: 'endpoint is required' })
    if (endpoint && !isUrl(endpoint)) issues.push({ path: `${path}.endpoint`, message: 'endpoint must be an http(s) URL' })
    if (provider.requiresSecret && !c.secretRef) issues.push({ path: `${path}.secretRef`, message: 'a secret is required' })
  }

  const agents = new Map(knownAgents(config).map((a) => [a.id, a]))
  for (const a of config.agents) {
    if (a.adapter !== 'terminal' && !a.command.trim()) issues.push({ path: `agents.${a.id}.command`, message: 'command is required' })
    checkEnv(a.env, `agents.${a.id}.env`, issues)
  }
  for (const acc of config.accounts) {
    if (!agents.has(acc.agentId)) issues.push({ path: `accounts.${acc.id}.agentId`, message: `unknown agent "${acc.agentId}"` })
    checkEnv(acc.env, `accounts.${acc.id}.env`, issues)
  }

  const connections = new Map(config.connections.map((c) => [c.id, c]))
  const accounts = new Set(config.accounts.map((a) => a.id))
  for (const p of config.profiles) {
    const path = `profiles.${p.id}`
    for (const kind of CONNECTION_KINDS) {
      const ref = p.connections[kind]
      if (ref === undefined) continue
      const c = connections.get(ref)
      if (!c) issues.push({ path: `${path}.connections.${kind}`, message: `unknown connection "${ref}"` })
      else if (c.kind !== kind) {
        issues.push({ path: `${path}.connections.${kind}`, message: `connection "${ref}" is a ${c.kind} connection, not ${kind}` })
      }
    }
    for (const a of p.accountIds) {
      if (!accounts.has(a)) issues.push({ path: `${path}.accountIds`, message: `unknown account "${a}"` })
    }
    for (const a of p.agentIds ?? []) {
      if (!agents.has(a)) issues.push({ path: `${path}.agentIds`, message: `unknown agent "${a}"` })
    }
  }
  if (config.activeProfileId && !config.profiles.some((p) => p.id === config.activeProfileId)) {
    issues.push({ path: 'activeProfileId', message: `unknown profile "${config.activeProfileId}"` })
  }
  return issues
}
