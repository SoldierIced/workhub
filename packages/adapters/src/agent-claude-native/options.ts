/**
 * What the user's Claude Code offers before any session: the models it lists for the account (the
 * `fable` alias moves to a new model without Workhub changing). Read through `bridge/options.mjs`,
 * which starts a session without a prompt and ends it once Claude Code reported its options.
 */
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import type { ModelOption } from '@workhub/core'

export interface ClaudeOptionsDeps {
  /** Folder holding the bridge scripts. */
  bridgeDir: string
  /** Node to run the script with; defaults to the running executable as Node (ELECTRON_RUN_AS_NODE). */
  nodeCommand?: string
  /** The PATH to start with (the login shell's), so the user's `claude` is found, not only the bundled one. */
  path?: () => string | undefined
  timeoutMs?: number
}

export interface ClaudeOptions {
  models: ModelOption[]
}

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj | undefined => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

/** The models in the script's answer, as the pickers list them; throws on a failed or empty reading. */
export function claudeOptionsFromProbe(raw: unknown): ClaudeOptions {
  const o = obj(raw)
  if (!o || o['ok'] !== true) throw new Error(str(o?.['error']) ?? 'Claude Code did not report its options')
  const models = (Array.isArray(o['models']) ? o['models'] : []).flatMap((m): ModelOption[] => {
    const info = obj(m)
    const id = str(info?.['value'])
    if (!id) return []
    const description = str(info?.['description'])
    return [{ id, name: str(info?.['displayName']) ?? id, ...(description ? { description } : {}) }]
  })
  if (!models.length) throw new Error('Claude Code listed no models')
  return { models }
}

/** Reads the models Claude Code offers for one account (its config folder; none: the default `~/.claude`). */
export function discoverClaudeOptions(deps: ClaudeOptionsDeps, configDir?: string): Promise<ClaudeOptions> {
  const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  const path = deps.path?.()
  if (path) env[Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'] = path
  if (configDir) env['CLAUDE_CONFIG_DIR'] = configDir
  else delete env['CLAUDE_CONFIG_DIR']
  return new Promise((resolve, reject) => {
    execFile(
      deps.nodeCommand ?? process.execPath,
      [join(deps.bridgeDir, 'options.mjs')],
      { env, maxBuffer: 8 * 1024 * 1024, timeout: deps.timeoutMs ?? 60_000, windowsHide: true },
      (err, stdout) => {
        const line = stdout.trim().split('\n').pop() ?? ''
        try {
          resolve(claudeOptionsFromProbe(JSON.parse(line)))
        } catch (parseErr) {
          reject(line ? parseErr : (err ?? parseErr))
        }
      }
    )
  })
}
