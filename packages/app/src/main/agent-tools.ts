/**
 * Workhub's tools for agents (Settings → Agents → Workhub tools): how an agent learns to reach the
 * control endpoint. Two ways, which can be used together:
 *
 * - **MCP**: Workhub's MCP server (`workhub-mcp.mjs`, with the bridge scripts) handed to every
 *   session that reaches the endpoint (`workhubMcpLaunch`), and optionally installed in Claude
 *   Code's user settings for sessions outside Workhub (`claude mcp add-json`).
 * - **Skills**: the `workhub-*` skills copied into each Claude config folder's `skills/`. Each
 *   copy carries a `.workhub-skill` marker, so only copies Workhub made are updated or removed.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { McpServerLaunch, Probe, WorkhubConfig } from '@workhub/core'
import type { AgentToolsStatus, SkillState } from '../shared/agent-tools-api'
import { claudeAccounts, claudeConfigDirOf } from './claude-accounts'
import type { IpcRegistrar } from './ipc-guard'

export const WORKHUB_MCP_SCRIPT = 'workhub-mcp.mjs'
/** The name of Workhub's server in a session and in Claude Code's settings. */
export const WORKHUB_MCP_NAME = 'workhub'
const MARKER = '.workhub-skill'
const SKILL_NAME = /^workhub-[a-z0-9-]{1,60}$/

/**
 * Workhub's MCP server for a session, from the session's environment: nothing when the session
 * does not reach the endpoint (a reviewer, or no endpoint listens).
 */
export function workhubMcpLaunch(env: Record<string, string>, where: { node: string; script: string }): McpServerLaunch[] {
  const session = env['WORKHUB_SESSION'] ?? ''
  if (!session || (!env['WORKHUB_SOCKET'] && !env['WORKHUB_URL'])) return []
  const pass = ['WORKHUB_SESSION', 'WORKHUB_SOCKET', 'WORKHUB_URL', 'WORKHUB_TOKEN'] as const
  return [
    {
      name: WORKHUB_MCP_NAME,
      command: where.node,
      args: [where.script],
      env: { ELECTRON_RUN_AS_NODE: '1', ...Object.fromEntries(pass.filter((k) => env[k]).map((k) => [k, env[k]!])) }
    }
  ]
}

/** The skills Workhub ships: folder name and SKILL.md text, from `<dir>/<name>/SKILL.md`. */
export function bundledSkills(dir: string): { name: string; text: string }[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && SKILL_NAME.test(d.name) && existsSync(join(dir, d.name, 'SKILL.md')))
    .map((d) => ({ name: d.name, text: readFileSync(join(dir, d.name, 'SKILL.md'), 'utf8') }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16)

/** One skill in one skills folder: missing, Workhub's copy (current or outdated), or the user's own (left alone). */
export function skillState(skillsDir: string, skill: { name: string; text: string }): SkillState {
  const folder = join(skillsDir, skill.name)
  const file = join(folder, 'SKILL.md')
  if (!existsSync(file)) return 'missing'
  if (!existsSync(join(folder, MARKER))) return 'own'
  return readFileSync(file, 'utf8') === skill.text ? 'current' : 'outdated'
}

/** Copies every skill into a skills folder (new ones and Workhub's outdated copies; never the user's own). */
export function installSkills(skillsDir: string, skills: readonly { name: string; text: string }[]): string[] {
  const written: string[] = []
  for (const s of skills) {
    const state = skillState(skillsDir, s)
    if (state === 'current' || state === 'own') continue
    const folder = join(skillsDir, s.name)
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'SKILL.md'), s.text)
    writeFileSync(join(folder, MARKER), `Installed by Workhub (${hash(s.text)}). Workhub updates and removes this folder; edit a copy under another name.\n`)
    written.push(s.name)
  }
  return written
}

/** Removes Workhub's copies of the skills from a skills folder (only folders with the marker). */
export function removeSkills(skillsDir: string, skills: readonly { name: string }[]): string[] {
  const removed: string[] = []
  for (const s of skills) {
    const folder = join(skillsDir, s.name)
    if (!existsSync(join(folder, MARKER))) continue
    rmSync(folder, { recursive: true, force: true })
    removed.push(s.name)
  }
  return removed
}

/** The `claude mcp add-json` value of Workhub's server for agents outside Workhub (its socket named in the args). */
export function globalMcpJson(where: { node: string; script: string; socket: string }): string {
  return JSON.stringify({ type: 'stdio', command: where.node, args: [where.script, '--socket', where.socket], env: { ELECTRON_RUN_AS_NODE: '1' } })
}

export interface AgentToolsDeps {
  config: () => Promise<WorkhubConfig>
  home: string
  /** Folder with the `workhub-*` skill folders (the repo's `skills/`, `<resources>/skills` when packaged). */
  skillsDir: string
  node: string
  /** Path of `workhub-mcp.mjs`. */
  script: string
  /** The endpoint's socket, null while none listens or on Windows (a token per launch cannot be installed). */
  socket: () => string | null
  /** Runs `claude` with an environment (the setup runner). */
  run: (command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => Promise<Probe>
  /** The environment `claude` runs in (PATH with the bundled Claude Code). */
  env: () => NodeJS.ProcessEnv
}

/** The Claude config folders, each with a label for the UI (empty: the default folder). */
async function folders(deps: AgentToolsDeps): Promise<{ id: string; name: string; dir: string }[]> {
  const config = await deps.config()
  const seen = new Set<string>()
  return claudeAccounts(config, deps.home)
    .map((ref) => {
      const account = config.accounts.find((a) => a.id === ref.accountId) ?? null
      return { id: ref.accountId ?? 'default', name: ref.name, dir: resolve(claudeConfigDirOf(config, account, deps.home)) }
    })
    .filter((f) => (seen.has(f.dir) ? false : (seen.add(f.dir), true)))
}

export class AgentToolsService {
  constructor(private readonly deps: AgentToolsDeps) {}

  private envFor(dir: string): NodeJS.ProcessEnv {
    return { ...this.deps.env(), CLAUDE_CONFIG_DIR: dir }
  }

  async status(): Promise<AgentToolsStatus> {
    const skills = bundledSkills(this.deps.skillsDir)
    const list = await folders(this.deps)
    const socket = this.deps.socket()
    const accounts = await Promise.all(
      list.map(async (f) => {
        const mcp = socket ? await this.deps.run('claude', ['mcp', 'get', WORKHUB_MCP_NAME], { env: this.envFor(f.dir) }) : null
        return {
          id: f.id,
          name: f.name,
          dir: f.dir,
          skills: Object.fromEntries(skills.map((s) => [s.name, skillState(join(f.dir, 'skills'), s)])),
          globalMcp: mcp === null ? ('unavailable' as const) : mcp.result === 'ok' ? ('installed' as const) : mcp.result === 'notFound' ? ('noClaude' as const) : ('missing' as const)
        }
      })
    )
    return { skills: skills.map((s) => s.name), accounts, globalMcpAvailable: socket !== null }
  }

  /** How many Claude folders have every skill (Workhub's current copy or the user's own), and how many an older copy. */
  async skillsSummary(): Promise<{ installed: number; outdated: number; total: number }> {
    const skills = bundledSkills(this.deps.skillsDir)
    const list = await folders(this.deps)
    const states = list.map((f) => skills.map((s) => skillState(join(f.dir, 'skills'), s)))
    return {
      total: list.length,
      installed: states.filter((st) => st.every((s) => s === 'current' || s === 'own')).length,
      outdated: states.filter((st) => st.includes('outdated')).length
    }
  }

  async installSkills(accountId: string): Promise<string[]> {
    const f = (await folders(this.deps)).find((x) => x.id === accountId)
    if (!f) throw new Error('unknown account')
    return installSkills(join(f.dir, 'skills'), bundledSkills(this.deps.skillsDir))
  }

  async removeSkills(accountId: string): Promise<string[]> {
    const f = (await folders(this.deps)).find((x) => x.id === accountId)
    if (!f) throw new Error('unknown account')
    return removeSkills(join(f.dir, 'skills'), bundledSkills(this.deps.skillsDir))
  }

  /** Adds (or replaces) Workhub's server in the account's Claude Code user settings. */
  async installGlobalMcp(accountId: string): Promise<{ ok: boolean; output: string }> {
    const f = (await folders(this.deps)).find((x) => x.id === accountId)
    const socket = this.deps.socket()
    if (!f || !socket) return { ok: false, output: !f ? 'unknown account' : 'the endpoint is not a socket here' }
    const env = this.envFor(f.dir)
    await this.deps.run('claude', ['mcp', 'remove', WORKHUB_MCP_NAME, '--scope', 'user'], { env })
    const r = await this.deps.run('claude', ['mcp', 'add-json', WORKHUB_MCP_NAME, globalMcpJson({ node: this.deps.node, script: this.deps.script, socket }), '--scope', 'user'], { env })
    return { ok: r.result === 'ok', output: r.output }
  }

  async removeGlobalMcp(accountId: string): Promise<{ ok: boolean; output: string }> {
    const f = (await folders(this.deps)).find((x) => x.id === accountId)
    if (!f) return { ok: false, output: 'unknown account' }
    const r = await this.deps.run('claude', ['mcp', 'remove', WORKHUB_MCP_NAME, '--scope', 'user'], { env: this.envFor(f.dir) })
    return { ok: r.result === 'ok', output: r.output }
  }
}

const accountArg = (v: unknown): string => {
  if (typeof v !== 'string' || !/^[\w.:-]{1,200}$/.test(v)) throw new Error('bad account')
  return v
}

export function registerAgentToolsIpc(ipc: IpcRegistrar, service: AgentToolsService): void {
  ipc.handle('agentTools:status', () => service.status())
  ipc.handle('agentTools:installSkills', (_e, id: unknown) => service.installSkills(accountArg(id)))
  ipc.handle('agentTools:removeSkills', (_e, id: unknown) => service.removeSkills(accountArg(id)))
  ipc.handle('agentTools:installGlobalMcp', (_e, id: unknown) => service.installGlobalMcp(accountArg(id)))
  ipc.handle('agentTools:removeGlobalMcp', (_e, id: unknown) => service.removeGlobalMcp(accountArg(id)))
}
