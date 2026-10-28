import type { AgentCapabilities, AgentCapabilityName } from '../domain/agent'
import type { MonitorField, SessionMonitorSnapshot } from '../domain/monitor'
import { OFFERED_MODULES, type ModuleToggles, type OptionalModule } from '../domain/profile'

/** The capability that must be on for a monitor field to be shown. `null`: always allowed. */
const FIELD_CAPABILITY: Record<MonitorField, AgentCapabilityName | null> = {
  title: null,
  model: 'models',
  tokens: 'usage',
  cost: 'usage',
  credits: 'usage',
  context: 'usage',
  toolCalls: 'appMode',
  subagents: 'subagents',
  activeTime: null,
  planUsage: 'planUsage',
  mcpServers: 'mcpStatus',
  pullRequests: 'transcript',
  tickets: 'transcript'
}

const FIELD_VALUE: Record<MonitorField, (s: SessionMonitorSnapshot) => unknown> = {
  title: (s) => s.title,
  model: (s) => s.model,
  tokens: (s) => s.tokens,
  cost: (s) => s.cost,
  credits: (s) => s.credits ?? s.lastTurnCredits,
  context: (s) => s.context,
  toolCalls: (s) => s.toolCalls,
  subagents: (s) => s.subagents,
  activeTime: (s) => s.activeTimeMs,
  planUsage: (s) => s.planUsage,
  mcpServers: (s) => s.mcpServers,
  pullRequests: (s) => s.pullRequests,
  tickets: (s) => s.ticketKeys
}

function hasValue(v: unknown): boolean {
  if (v === undefined || v === null) return false
  if (Array.isArray(v)) return v.length > 0
  if (typeof v === 'object') return Object.values(v as object).some((x) => x !== undefined)
  return true
}

/**
 * Monitor fields to show for a session: the agent must support the field AND have reported a
 * value. Missing data hides the field (PLAN "Session monitor": fail soft).
 */
export function visibleMonitorFields(capabilities: AgentCapabilities, snapshot: SessionMonitorSnapshot): MonitorField[] {
  return (Object.keys(FIELD_CAPABILITY) as MonitorField[]).filter((field) => {
    const cap = FIELD_CAPABILITY[field]
    return (cap === null || capabilities[cap]) && hasValue(FIELD_VALUE[field](snapshot))
  })
}

export type SessionScreen = 'chat' | 'terminal' | 'monitor' | 'history' | 'transcript' | 'mcp' | 'planUsage'

/** Session screens or panels the UI offers for an agent, from its capabilities alone. */
export function sessionScreens(capabilities: AgentCapabilities): SessionScreen[] {
  const screens: SessionScreen[] = [capabilities.appMode ? 'chat' : 'terminal']
  if (capabilities.usage || capabilities.subagents || capabilities.mcpStatus || capabilities.appMode) screens.push('monitor')
  if (capabilities.history) screens.push('history')
  if (capabilities.transcript) screens.push('transcript')
  if (capabilities.mcpStatus) screens.push('mcp')
  if (capabilities.planUsage) screens.push('planUsage')
  return screens
}

/** Optional-module screens a profile turns on (retired modules never have one). */
export function moduleScreens(modules: ModuleToggles | undefined): OptionalModule[] {
  return OFFERED_MODULES.filter((m) => modules?.[m] === true)
}

/** Merges a partial monitor update into a snapshot. Lists and nested objects are replaced whole. */
export function mergeMonitor(base: SessionMonitorSnapshot, patch: SessionMonitorSnapshot): SessionMonitorSnapshot {
  const out: SessionMonitorSnapshot = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v
  }
  return out
}
