import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { BUILTIN_AGENTS, consoleCommand, emptyConfig } from '@workhub/core'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentToolsService, agentSkillFolders, bundledSkills, globalMcpJson, installSkills, pickSkills, removeSkills, skillState, workhubMcpLaunch } from '../src/main/agent-tools'
import { MODULE_SKILL, needsSkill, skillTargets } from '../src/renderer/screens/settings/InstallSkillDialog'
import { consoleMcpConfig } from '../src/main/session-manager'

const dirs: string[] = []
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'wh-tools-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe("Workhub's MCP server for a session", () => {
  it('is handed to sessions that reach the endpoint, with only the endpoint variables', () => {
    const where = { node: '/app/Workhub', script: '/app/bridge/workhub-mcp.mjs' }
    expect(workhubMcpLaunch({ WORKHUB_SESSION: 's1', WORKHUB_SOCKET: '/d/control.sock', WORKHUB_URL: '', WORKHUB_TOKEN: '', HOME: '/h' }, where)).toEqual([
      { name: 'workhub', command: '/app/Workhub', args: ['/app/bridge/workhub-mcp.mjs'], env: { ELECTRON_RUN_AS_NODE: '1', WORKHUB_SESSION: 's1', WORKHUB_SOCKET: '/d/control.sock' } }
    ])
    expect(workhubMcpLaunch({ WORKHUB_SESSION: 's1', WORKHUB_URL: 'http://127.0.0.1:5', WORKHUB_TOKEN: 't' }, where)[0]!.env).toEqual({ ELECTRON_RUN_AS_NODE: '1', WORKHUB_SESSION: 's1', WORKHUB_URL: 'http://127.0.0.1:5', WORKHUB_TOKEN: 't' })
    // The session's own token goes to its MCP server, which sends it with every call.
    expect(workhubMcpLaunch({ WORKHUB_SESSION: 's1', WORKHUB_SESSION_TOKEN: 'st', WORKHUB_SOCKET: '/d/control.sock' }, where)[0]!.env).toEqual({ ELECTRON_RUN_AS_NODE: '1', WORKHUB_SESSION: 's1', WORKHUB_SESSION_TOKEN: 'st', WORKHUB_SOCKET: '/d/control.sock' })
    // A reviewer (empty variables) or no endpoint: none.
    expect(workhubMcpLaunch({ WORKHUB_SESSION: '', WORKHUB_SOCKET: '' }, where)).toEqual([])
    expect(workhubMcpLaunch({ WORKHUB_SESSION: 's1' }, where)).toEqual([])
  })

  it("reaches Claude's console through --mcp-config, never on Windows", () => {
    const servers = [{ name: 'workhub', command: '/app/Workhub', args: ['/x.mjs'], env: { A: '1' } }]
    const json = consoleMcpConfig(servers, 'darwin')!
    expect(JSON.parse(json)).toEqual({ mcpServers: { workhub: { type: 'stdio', command: '/app/Workhub', args: ['/x.mjs'], env: { A: '1' } } } })
    expect(consoleMcpConfig(servers, 'win32')).toBeUndefined()
    expect(consoleMcpConfig([], 'darwin')).toBeUndefined()
    const claude = BUILTIN_AGENTS.find((a) => a.id === 'claude')!.console!
    expect(consoleCommand(claude, 'abc', false, undefined, json).args).toEqual(['--session-id', 'abc', '--mcp-config', json])
    expect(consoleCommand(claude, 'abc', true).args).toEqual(['--resume', 'abc'])
  })

  it('is installed outside Workhub with the socket named in its args', () => {
    expect(JSON.parse(globalMcpJson({ node: '/app/Workhub', script: '/x.mjs', socket: '/d/control.sock' }))).toEqual({ type: 'stdio', command: '/app/Workhub', args: ['/x.mjs', '--socket', '/d/control.sock'], env: { ELECTRON_RUN_AS_NODE: '1' } })
  })
})

describe('Workhub skills in a Claude folder', () => {
  it('ships the repo skills', () => {
    const names = bundledSkills(resolve(__dirname, '../../../skills')).map((s) => s.name)
    expect(names).toEqual(expect.arrayContaining(['workhub-analytics', 'workhub-automations', 'workhub-board', 'workhub-flow-map', 'workhub-plan', 'workhub-sessions']))
  })

  it('installs, updates and removes only its own copies', () => {
    const skillsDir = join(tmp(), 'skills')
    const v1 = [
      { name: 'workhub-plan', text: '---\nname: workhub-plan\n---\nv1' },
      { name: 'workhub-automations', text: '---\nname: workhub-automations\n---\nv1' }
    ]
    expect(skillState(skillsDir, v1[0]!)).toBe('missing')
    // A folder the user made with the same name is theirs.
    mkdirSync(join(skillsDir, 'workhub-automations'), { recursive: true })
    writeFileSync(join(skillsDir, 'workhub-automations', 'SKILL.md'), 'mine')
    expect(installSkills(skillsDir, v1)).toEqual(['workhub-plan'])
    expect(skillState(skillsDir, v1[0]!)).toBe('current')
    expect(skillState(skillsDir, v1[1]!)).toBe('own')

    const v2 = v1.map((s) => ({ ...s, text: s.text.replace('v1', 'v2') }))
    expect(skillState(skillsDir, v2[0]!)).toBe('outdated')
    expect(installSkills(skillsDir, v2)).toEqual(['workhub-plan'])
    expect(readFileSync(join(skillsDir, 'workhub-plan', 'SKILL.md'), 'utf8')).toContain('v2')

    expect(removeSkills(skillsDir, v2)).toEqual(['workhub-plan'])
    expect(existsSync(join(skillsDir, 'workhub-plan'))).toBe(false)
    expect(readFileSync(join(skillsDir, 'workhub-automations', 'SKILL.md'), 'utf8')).toBe('mine')
  })
})

describe('the claude commands of the Workhub tools', () => {
  it('name a folder for an account of its own only: the default account reads what its sessions read', async () => {
    const config = { ...emptyConfig(), accounts: [{ id: 'work', agentId: 'claude', name: 'Work', configDir: '/tmp/acme-claude-work' }] }
    const seen: (string | undefined)[] = []
    const service = new AgentToolsService({
      config: async () => config,
      home: '/tmp/acme-home',
      skillsDir: tmp(),
      node: '/app/Workhub',
      script: '/x.mjs',
      socket: () => '/d/control.sock',
      run: async (_command, _args, options) => {
        seen.push(options.env?.['CLAUDE_CONFIG_DIR'])
        return { result: 'failed', output: '' }
      },
      env: () => ({ PATH: '/usr/bin' })
    })
    const status = await service.status()
    expect(status.accounts.map((a) => a.id)).toEqual(['default', 'work'])
    // The skills path keeps the real folder of the default account.
    expect(status.accounts[0]!.dir).toBe(resolve('/tmp/acme-home/.claude'))
    expect(seen).toEqual([undefined, resolve('/tmp/acme-claude-work')])
  })

  it('name the default folder when an account is configured with it, as its sessions do', async () => {
    const config = { ...emptyConfig(), accounts: [{ id: 'main', agentId: 'claude', name: 'Main', configDir: '/tmp/acme-home/.claude' }] }
    const seen: (string | undefined)[] = []
    const service = new AgentToolsService({
      config: async () => config,
      home: '/tmp/acme-home',
      skillsDir: tmp(),
      node: '/app/Workhub',
      script: '/x.mjs',
      socket: () => '/d/control.sock',
      run: async (_command, _args, options) => {
        seen.push(options.env?.['CLAUDE_CONFIG_DIR'])
        return { result: 'failed', output: '' }
      },
      env: () => ({ PATH: '/usr/bin' })
    })
    const status = await service.status()
    expect(status.accounts.map((a) => a.id)).toEqual(['main'])
    expect(seen).toEqual([resolve('/tmp/acme-home/.claude')])
  })
})

describe('Workhub skills for the other agents', () => {
  it('offers only the agents whose home folder exists, where each one reads skills', () => {
    const home = '/tmp/acme-home'
    const all = agentSkillFolders(home, { CODEX_HOME: '/tmp/acme-codex' }, () => true)
    expect(all.map((a) => [a.id, a.dir])).toEqual([
      ['agent:codex', resolve('/tmp/acme-codex/skills')],
      ['agent:opencode', resolve('/tmp/acme-home/.config/opencode/skills')],
      ['agent:gemini', resolve('/tmp/acme-home/.gemini/skills')],
      ['agent:kiro', resolve('/tmp/acme-home/.kiro/skills')]
    ])
    expect(agentSkillFolders(home, {}, (p) => p.endsWith('.gemini')).map((a) => a.id)).toEqual(['agent:gemini'])
    expect(agentSkillFolders(home, { XDG_CONFIG_HOME: '/tmp/acme-xdg' }, (p) => p.includes('opencode'))[0]!.dir).toBe(resolve('/tmp/acme-xdg/opencode/skills'))
  })

  it('picks the named skills and refuses an unknown one', () => {
    const skills = [{ name: 'workhub-board' }, { name: 'workhub-plan' }]
    expect(pickSkills(skills)).toEqual(skills)
    expect(pickSkills(skills, ['workhub-board'])).toEqual([{ name: 'workhub-board' }])
    expect(() => pickSkills(skills, ['workhub-nope'])).toThrow(/unknown skill/)
  })

  it('installs one skill into an agent folder and a Claude folder, and lists both', async () => {
    const home = tmp()
    mkdirSync(join(home, '.gemini'))
    const shipped = tmp()
    for (const name of ['workhub-board', 'workhub-plan']) {
      mkdirSync(join(shipped, name))
      writeFileSync(join(shipped, name, 'SKILL.md'), `---\nname: ${name}\n---\n`)
    }
    const service = new AgentToolsService({
      config: async () => emptyConfig(),
      home,
      skillsDir: shipped,
      node: '/app/Workhub',
      script: '/x.mjs',
      socket: () => null,
      run: async () => ({ result: 'failed', output: '' }),
      env: () => ({})
    })
    expect(await service.installSkills('agent:gemini', ['workhub-board'])).toEqual(['workhub-board'])
    expect(await service.installSkills('default', ['workhub-board'])).toEqual(['workhub-board'])
    const status = await service.status()
    expect(status.agents).toEqual([{ id: 'agent:gemini', agentId: 'gemini', name: 'Gemini CLI', dir: resolve(home, '.gemini/skills'), skills: { 'workhub-board': 'current', 'workhub-plan': 'missing' } }])
    expect(status.accounts[0]!.skills).toEqual({ 'workhub-board': 'current', 'workhub-plan': 'missing' })
    await expect(service.installSkills('agent:codex')).rejects.toThrow(/unknown agent/)
    expect(await service.removeSkills('agent:gemini')).toEqual(['workhub-board'])

    // The dialog asked when a screen is turned on: every target, the ones lacking the skill first checked.
    const targets = skillTargets(await service.status(), MODULE_SKILL.boards!, (n) => (n ? `Claude Code · ${n}` : 'Claude Code'))
    expect(targets.map((x) => [x.id, x.label, x.state])).toEqual([
      ['default', 'Claude Code', 'current'],
      ['agent:gemini', 'Gemini CLI', 'missing']
    ])
    expect(targets.filter((x) => needsSkill(x.state)).map((x) => x.id)).toEqual(['agent:gemini'])
  })

  it('names a shipped skill for every screen that has one', () => {
    const names = bundledSkills(resolve(__dirname, '../../../skills')).map((s) => s.name)
    for (const skill of Object.values(MODULE_SKILL)) expect(names).toContain(skill)
  })
})
