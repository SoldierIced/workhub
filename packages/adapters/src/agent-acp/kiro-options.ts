/**
 * What Kiro offers before a session exists, for the New session dialog and Settings: its models
 * (`kiro-cli chat --list-models -f json`) and its agents (`kiro-cli agent list`). Both commands
 * only list (checked on Kiro 2.33.1): no model turn, no session file. Inside a session the same
 * lists arrive over ACP as `models` and `modes` (Kiro's modes are its agents).
 */
import type { ModelOption, SessionModeOption } from '@workhub/core'
import type { CliRunner } from '../shared/cli'

export interface AgentOptions {
  models: ModelOption[]
  /** ACP session modes: Kiro's agents, OpenCode's agents, Codex's approval presets. */
  modes: SessionModeOption[]
  defaultModelId?: string
  defaultModeId?: string
}

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj | undefined => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/** `kiro-cli chat --list-models -f json`: `{models: [{model_id, model_name, description, rate_multiplier, rate_unit}], default_model}`. */
export function parseKiroModels(stdout: string): { models: ModelOption[]; defaultModelId?: string } {
  let raw: Obj | undefined
  try {
    raw = obj(JSON.parse(stdout))
  } catch {
    return { models: [] }
  }
  const models = (Array.isArray(raw?.['models']) ? (raw['models'] as unknown[]) : []).flatMap((m): ModelOption[] => {
    const o = obj(m)
    const id = str(o?.['model_id'])
    if (!id) return []
    const rate = num(o?.['rate_multiplier'])
    const unit = str(o?.['rate_unit'])
    const parts = [str(o?.['description']), rate !== undefined ? `${rate}x ${unit?.toLowerCase() ?? 'credit'}` : undefined].filter(Boolean)
    return [{ id, name: str(o?.['model_name']) ?? id, ...(parts.length ? { description: parts.join(' · ') } : {}) }]
  })
  const defaultModelId = str(raw?.['default_model'])
  return { models, ...(defaultModelId ? { defaultModelId } : {}) }
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g
const ROW = /^([* ]) (\S+)\s{2,}(Global|Workspace|\(Built-in\))(?:\s{2,}(.*))?$/

/**
 * `kiro-cli agent list`: one row per agent (`* name  Scope  Description`, `*` marks the default)
 * with the description wrapped onto indented lines. Header lines are skipped.
 */
export function parseKiroAgentList(stdout: string): { modes: SessionModeOption[]; defaultModeId?: string } {
  const modes: SessionModeOption[] = []
  let defaultModeId: string | undefined
  let current: SessionModeOption | undefined
  for (const rawLine of stdout.replace(ANSI, '').split('\n')) {
    const line = rawLine.replace(/\s+$/, '')
    const row = ROW.exec(line)
    if (row) {
      current = { id: row[2]!, name: row[2]!, ...(row[4] ? { description: row[4].trim() } : {}) }
      modes.push(current)
      if (row[1] === '*') defaultModeId = current.id
      continue
    }
    // A wrapped description line: deeply indented text under the last row.
    if (current && /^\s{8,}\S/.test(line)) current.description = [current.description, line.trim()].filter(Boolean).join(' ')
    else if (!line.trim()) current = undefined
  }
  return { modes, ...(defaultModeId ? { defaultModeId } : {}) }
}

/** Kiro's models and agents through its CLI. A command that fails leaves its list empty. */
export async function discoverKiroOptions(run: CliRunner, command = 'kiro-cli'): Promise<AgentOptions> {
  const [models, agents] = await Promise.all([
    run(command, ['chat', '--list-models', '-f', 'json'], { timeoutMs: 30_000 }).then(
      (r) => (r.code === 0 ? parseKiroModels(r.stdout) : { models: [] }),
      () => ({ models: [] })
    ),
    run(command, ['agent', 'list'], { timeoutMs: 30_000 }).then(
      // Kiro 2.33 prints the list on stderr.
      (r) => (r.code === 0 ? parseKiroAgentList(`${r.stdout}\n${r.stderr}`) : { modes: [] }),
      () => ({ modes: [] })
    )
  ])
  return { ...models, ...agents }
}
