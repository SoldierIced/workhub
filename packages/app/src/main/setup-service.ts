import { execFile } from 'node:child_process'
import { statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  agentItem,
  claudeCodeItem,
  claudeSignInItem,
  githubItem,
  healthItem,
  jiraItem,
  nodeItem,
  profileItem,
  slackItem,
  usageItem,
  appOptions,
  type Probe,
  type SetupItem,
  type WorkhubConfig
} from '@workhub/core'
import { claudeAccounts, claudeConfigDirOf } from './claude-accounts'

/** Seconds a command-line check may take. */
export const SETUP_TIMEOUT_MS = 10_000

/** The file a Windows shell would run for `command` (PATH folders, then PATHEXT extensions), or null. */
export function findOnWindowsPath(command: string, env: NodeJS.ProcessEnv): string | null {
  const value = (name: string) => Object.entries(env).find(([k]) => k.toUpperCase() === name)?.[1]
  const exts = (value('PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  const hasExt = /\.[^\\/.]+$/.test(command)
  const names = hasExt ? [command, ...exts.map((e) => command + e)] : exts.map((e) => command + e)
  const dirs = /[\\/]/.test(command) ? [''] : (value('PATH') ?? '').split(';').filter(Boolean)
  for (const dir of dirs) {
    for (const name of names) {
      const full = dir ? join(dir, name) : name
      try {
        if (statSync(full).isFile()) return full
      } catch {
        /* not here */
      }
    }
  }
  return null
}

/** Runs one command and reports how it ended; a slow or hanging tool never holds the window. */
export function probe(command: string, args: string[], options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<Probe> {
  return new Promise((done) => {
    const env = options.env ?? process.env
    // cmd.exe reports a missing command as an ordinary failure (localized text, exit code 1), so on
    // Windows the command is looked up first; only `.cmd`/`.bat` shims need the shell.
    const found = process.platform === 'win32' ? findOnWindowsPath(command, env) : command
    if (!found) return done({ result: 'notFound', output: '' })
    execFile(
      found,
      args,
      { env, timeout: options.timeoutMs ?? SETUP_TIMEOUT_MS, windowsHide: true, maxBuffer: 1 << 20, shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(found) },
      (err, stdout, stderr) => {
        const output = String(stdout || stderr || '').trim()
        if (!err) return done({ result: 'ok', output })
        const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: string | number }
        if (e.code === 'ENOENT') return done({ result: 'notFound', output })
        if (e.killed || e.code === 'ETIMEDOUT') return done({ result: 'timeout', output })
        done({ result: 'failed', output })
      }
    )
  })
}

const shellQuoted = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

export interface SetupServiceDeps {
  config: () => Promise<WorkhubConfig>
  hasSecret: (ref: string) => Promise<boolean>
  /** The PATH tools are looked up on (the login shell's, plus the bundled Claude Code). */
  path: () => string
  home: string
  /** The Slack watcher's last failure, null when it is not failing. */
  slackFailure: () => Promise<string | null>
  /** Test seam: replaces the command runner. */
  run?: typeof probe
}

/** Checks what Workhub needs on this machine. Nothing here changes any setting. */
export class SetupService {
  constructor(private readonly deps: SetupServiceDeps) {}

  /** Every row, in display order, with its answer. */
  async run(): Promise<SetupItem[]> {
    const run = this.deps.run ?? probe
    const config = await this.deps.config()
    const base = { ...process.env, PATH: this.deps.path() }
    const defaultDir = resolve(process.env['CLAUDE_CONFIG_DIR'] || join(this.deps.home, '.claude'))

    const logins = claudeAccounts(config, this.deps.home).map(async (ref) => {
      const account = config.accounts.find((a) => a.id === ref.accountId) ?? null
      const dir = claudeConfigDirOf(config, account, this.deps.home)
      const isDefault = dir === defaultDir
      const env = isDefault ? base : { ...base, CLAUDE_CONFIG_DIR: dir }
      const login = isDefault ? 'claude auth login' : `CLAUDE_CONFIG_DIR=${shellQuoted(dir)} claude auth login`
      const p = await run('claude', ['auth', 'status'], { env })
      return claudeSignInItem(`claudeSignIn:${ref.accountId ?? 'default'}`, ref.name || 'Claude', p, login)
    })
    const node = (async () => {
      let p = await run('node', ['--version'], { env: base })
      // The Node scripts run `node` through the login shell, so one from a version manager counts too.
      if (p.result === 'notFound' && process.platform !== 'win32') p = await run(process.env['SHELL'] || '/bin/zsh', ['-ilc', 'node --version'])
      return nodeItem(p)
    })()
    const github = (async () => {
      const version = await run('gh', ['--version'], { env: base })
      if (version.result === 'notFound' || version.result === 'timeout') return githubItem(version, null, null)
      const user = await run('gh', ['api', 'user', '--jq', '.login'], { env: base })
      if (user.result === 'ok' && user.output) return githubItem(version, user, null)
      return githubItem(version, user, await run('gh', ['auth', 'token'], { env: base }))
    })()

    const secretRefs = new Set<string>()
    for (const c of config.connections) if (c.secretRef && (await this.deps.hasSecret(c.secretRef))) secretRefs.add(c.secretRef)
    const [claudeCode, codex, kiro, nodeItemResult, githubResult, ...loginItems] = await Promise.all([
      run('claude', ['--version'], { env: base }).then(claudeCodeItem),
      run('codex', ['--version'], { env: base }).then((p) => agentItem('codex', p)),
      run('kiro-cli', ['--version'], { env: base }).then((p) => agentItem('kiro', p)),
      node,
      github,
      ...logins
    ])
    const options = appOptions(config)
    return [
      claudeCode,
      ...loginItems,
      nodeItemResult,
      githubResult,
      profileItem(config),
      codex,
      kiro,
      jiraItem(config, (ref) => secretRefs.has(ref)),
      slackItem(config, await this.deps.slackFailure()),
      healthItem(config),
      usageItem(options)
    ]
  }
}
