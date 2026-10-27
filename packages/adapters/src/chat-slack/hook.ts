import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, copyFile, mkdir, readdir, readFile, rename, unlink } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import type { ChatTrackingHook, HookRecord, HookStatus } from '@workhub/core'
import { commonCliFolders } from '../shared/cli'
import { readFileIfExists, writeFileAtomic } from '../shared/atomic-file'

/** The copied script's name, which also marks Workhub 2's entry in settings.json (Workhub 1's hook is left alone). */
export const HOOK_SCRIPT_NAME = 'workhub2-slack-track-hook.mjs'
/** Claude Code tool names of Slack's send tools, whatever server they come from. */
export const HOOK_MATCHER = 'mcp__.*[Ss]lack.*send_message'
const INBOX = 'slack-track-inbox.jsonl'

type Settings = Record<string, unknown>
interface HookEntry {
  matcher?: string
  hooks?: { type?: string; command?: string; timeout?: number }[]
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function entries(settings: Settings): HookEntry[] {
  const hooks = settings['hooks']
  const list = isObject(hooks) ? hooks['PostToolUse'] : undefined
  return Array.isArray(list) ? (list as HookEntry[]) : []
}

const isOurs = (e: HookEntry) => Array.isArray(e?.hooks) && e.hooks.some((h) => String(h?.command ?? '').includes(HOOK_SCRIPT_NAME))

/** The installed hook command, or null. */
export function hookCommandIn(settings: Settings): string | null {
  for (const e of entries(settings)) for (const h of e.hooks ?? []) if (String(h?.command ?? '').includes(HOOK_SCRIPT_NAME)) return String(h.command)
  return null
}

/** A shell-safe double-quoted argument (POSIX shells and cmd.exe both accept it for plain paths). */
export function quoteArg(value: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? `"${value.replace(/"/g, '\\"')}"` : `"${value.replace(/(["\\$`])/g, '\\$1')}"`
}

/** Settings with Workhub 2's entry added or updated; everything else is left as it was. */
export function withHook(settings: Settings, command: string): { settings: Settings; changed: boolean } {
  const list = entries(settings)
  const entry: HookEntry = { matcher: HOOK_MATCHER, hooks: [{ type: 'command', command, timeout: 10 }] }
  const at = list.findIndex(isOurs)
  if (at >= 0) {
    const current = list[at]!
    if (current.matcher === HOOK_MATCHER && current.hooks?.length === 1 && current.hooks[0]?.command === command && current.hooks[0]?.timeout === 10) {
      return { settings, changed: false }
    }
  }
  const next = at >= 0 ? list.map((e, i) => (i === at ? entry : e)) : [...list, entry]
  const hooks = isObject(settings['hooks']) ? settings['hooks'] : {}
  return { settings: { ...settings, hooks: { ...hooks, PostToolUse: next } }, changed: true }
}

/** Settings without Workhub 2's entry; empty `PostToolUse` and `hooks` objects are removed too. */
export function withoutHook(settings: Settings): { settings: Settings; changed: boolean } {
  const list = entries(settings)
  const kept = list.filter((e) => !isOurs(e))
  if (kept.length === list.length) return { settings, changed: false }
  const hooks: Record<string, unknown> = { ...(settings['hooks'] as Record<string, unknown>) }
  if (kept.length) hooks['PostToolUse'] = kept
  else delete hooks['PostToolUse']
  const next: Settings = { ...settings, hooks }
  if (!Object.keys(hooks).length) delete next['hooks']
  return { settings: next, changed: true }
}

function parseSettings(text: string | null): Settings {
  if (text === null || !text.trim()) return {}
  const parsed: unknown = JSON.parse(text)
  if (!isObject(parsed)) throw new Error('settings.json is not a JSON object')
  return parsed
}

/** One inbox line as a record; null when it lacks the session, the channel or a ts. */
export function parseHookLine(line: string): HookRecord | null {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  if (!isObject(raw)) return null
  const s = (k: string) => (typeof raw[k] === 'string' && raw[k] ? (raw[k] as string) : undefined)
  const sessionId = s('sessionId')
  const channelId = s('channelId')
  const ts = s('ts')
  const threadTs = s('threadTs')
  if (!sessionId || !channelId || !(threadTs ?? ts)) return null
  const out: HookRecord = { sessionId, channelId }
  for (const k of ['cwd', 'configDir', 'ts', 'threadTs', 'permalink', 'title', 'text'] as const) {
    const v = s(k)
    if (v) out[k] = v
  }
  return out
}

/** `node` on the PATH or in the usual install folders, as an absolute path; null when not found. */
export async function findNode(platform: NodeJS.Platform = process.platform): Promise<string | null> {
  const name = platform === 'win32' ? 'node.exe' : 'node'
  const pathVar = Object.entries(process.env).find(([k]) => k.toLowerCase() === 'path')?.[1] ?? ''
  for (const dir of [...pathVar.split(delimiter), ...commonCliFolders(platform)].filter(Boolean)) {
    const candidate = join(dir, name)
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      // Not here.
    }
  }
  return null
}

export interface SlackTrackingHookOptions {
  /** Folder in Workhub's data folder holding the copied script, its inbox and its log. */
  dir: string
  /** The bundled `slack-track-hook.mjs`. */
  sourceScript: string
  /** Node that runs the hook; found on the PATH when unset. */
  node?: () => Promise<string | null>
  platform?: NodeJS.Platform
}

/**
 * Claude Code's PostToolUse hook that reports the Slack messages a session sends. `install` and
 * `remove` edit `<configDir>/settings.json` (a `.bak` copy is kept, the file is replaced
 * atomically, every other key is kept); they only run when the user asks in Settings.
 */
export class SlackTrackingHook implements ChatTrackingHook {
  constructor(private readonly options: SlackTrackingHookOptions) {}

  get script(): string {
    return join(this.options.dir, HOOK_SCRIPT_NAME)
  }

  get inbox(): string {
    return join(this.options.dir, INBOX)
  }

  async status(configDir: string): Promise<HookStatus> {
    try {
      const settings = parseSettings(await readFileIfExists(join(configDir, 'settings.json')))
      return hookCommandIn(settings) ? { state: 'installed' } : { state: 'notInstalled' }
    } catch (err) {
      return { state: 'unreadable', message: err instanceof Error ? err.message : String(err) }
    }
  }

  async install(configDir: string): Promise<void> {
    const node = await (this.options.node ?? (() => findNode(this.options.platform)))()
    if (!node) throw new Error('Node.js was not found on the PATH; the hook needs it to run.')
    await mkdir(this.options.dir, { recursive: true })
    await copyFile(this.options.sourceScript, this.script)
    const platform = this.options.platform ?? process.platform
    await this.edit(configDir, (s) => withHook(s, `${quoteArg(node, platform)} ${quoteArg(this.script, platform)}`))
  }

  async remove(configDir: string): Promise<void> {
    await this.edit(configDir, withoutHook)
  }

  private async edit(configDir: string, change: (s: Settings) => { settings: Settings; changed: boolean }): Promise<void> {
    const file = join(configDir, 'settings.json')
    const text = await readFileIfExists(file)
    const { settings, changed } = change(parseSettings(text))
    if (!changed) return
    if (text !== null) await writeFileAtomic(`${file}.bak`, text)
    await writeFileAtomic(file, JSON.stringify(settings, null, 2) + '\n')
  }

  /** Takes every waiting record. The inbox is renamed first, so lines the hook writes meanwhile go to a fresh one. */
  async drain(): Promise<HookRecord[]> {
    const dir = this.options.dir
    const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.startsWith('slack-track-inbox.processing-')).map((f) => join(dir, f))
    const claimed = join(dir, `slack-track-inbox.processing-${randomUUID()}.jsonl`)
    if (await rename(this.inbox, claimed).then(() => true, () => false)) files.push(claimed)
    const records: HookRecord[] = []
    for (const file of files) {
      const text = await readFile(file, 'utf8').catch(() => '')
      for (const line of text.split('\n')) {
        const r = line.trim() ? parseHookLine(line) : null
        if (r) records.push(r)
      }
      await unlink(file).catch(() => undefined)
    }
    return records
  }
}
