/**
 * Whether an agent's executable can be started: found on PATH (plus the folders Workhub adds),
 * the way `spawn` would find it. Used for the "not installed" state of the agent pickers.
 */
import { access, constants, stat } from 'node:fs/promises'
import { delimiter, isAbsolute, join } from 'node:path'
import type { AgentDefinition } from '@workhub/core'

export interface ExecutableLookup {
  /** The PATH to search; the process PATH when unset. */
  path?: string
  /** Folders searched before PATH (bundled agent adapters). */
  extraPath?: string[]
  platform?: NodeJS.Platform
  /** Windows executable extensions; `PATHEXT` when unset. */
  pathExt?: string
}

async function runnable(path: string, windows: boolean): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false
    if (!windows) await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** The full path of `command`, or null when it is not installed. */
export async function findExecutable(command: string, lookup: ExecutableLookup = {}): Promise<string | null> {
  if (!command) return null
  const windows = (lookup.platform ?? process.platform) === 'win32'
  const extensions = windows ? (lookup.pathExt ?? process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : ['']
  // Windows runs only files whose extension is in PATHEXT: an exact name qualifies when it already
  // has one of them (case-insensitive), otherwise each extension is appended.
  const hasExtension = windows && extensions.some((e) => command.toLowerCase().endsWith(e.toLowerCase()))
  const names = windows && !hasExtension ? extensions.map((e) => command + e.toLowerCase()) : [command]
  const folders = isAbsolute(command) || /[\\/]/.test(command) ? [''] : [...(lookup.extraPath ?? []), ...(lookup.path ?? process.env['PATH'] ?? '').split(delimiter)].filter(Boolean)
  for (const folder of folders) {
    for (const name of names) {
      const candidate = folder ? join(folder, name) : name
      if (await runnable(candidate, windows)) return candidate
    }
  }
  return null
}

/** For each agent id, whether its command is installed. A terminal agent without a command (the shell) always is. */
export async function agentAvailability(agents: readonly AgentDefinition[], lookup: ExecutableLookup = {}): Promise<Record<string, boolean>> {
  const entries = await Promise.all(
    agents.map(async (a): Promise<[string, boolean]> => [a.id, a.adapter === 'terminal' && !a.command ? true : (await findExecutable(a.command, lookup)) !== null])
  )
  return Object.fromEntries(entries)
}
