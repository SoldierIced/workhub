import { execFile } from 'node:child_process'
import { installCommand, isInstallerId, type InstallerId } from '@workhub/core'

/** An install may download and unpack a tool: ten minutes at most. */
export const INSTALL_TIMEOUT_MS = 10 * 60_000
/** Only the tail of the output goes back to the renderer. */
export const INSTALL_OUTPUT_CAP = 4000

export interface InstallResult {
  ok: boolean
  output: string
}

/** Runs one command line in a shell and reports how it ended. Test seam. */
export type ShellRunner = (command: string, options: { platform: NodeJS.Platform; timeoutMs: number }) => Promise<InstallResult>

const tail = (text: string): string => (text.length > INSTALL_OUTPUT_CAP ? text.slice(-INSTALL_OUTPUT_CAP) : text)

/** The login shell on macOS and Linux (so PATH and version managers match a terminal), PowerShell on Windows. */
export const runInShell: ShellRunner = (command, { platform, timeoutMs }) =>
  new Promise((done) => {
    const [file, args] = platform === 'win32' ? ['powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command]] : [process.env['SHELL'] || '/bin/zsh', ['-ilc', command]]
    execFile(file as string, args as string[], { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
      const output = tail(`${stdout}${stderr}`.trim())
      if (!err) return done({ ok: true, output })
      const e = err as NodeJS.ErrnoException & { killed?: boolean }
      done({ ok: false, output: output || (e.killed ? 'Timed out.' : e.message) })
    })
  })

export interface SetupInstallerDeps {
  platform?: NodeJS.Platform
  run?: ShellRunner
  timeoutMs?: number
}

/** Installs a missing tool with the command of the installer table, never with text from the renderer; one install at a time. */
export class SetupInstaller {
  private busy = false
  constructor(private readonly deps: SetupInstallerDeps = {}) {}

  async install(installer: unknown): Promise<InstallResult> {
    if (!isInstallerId(installer)) return { ok: false, output: 'Unknown installer.' }
    const platform = this.deps.platform ?? process.platform
    const command = installCommand(installer as InstallerId, platform)
    if (!command) return { ok: false, output: 'No installer for this platform.' }
    if (this.busy) return { ok: false, output: 'Another install is running.' }
    this.busy = true
    try {
      return await (this.deps.run ?? runInShell)(command, { platform, timeoutMs: this.deps.timeoutMs ?? INSTALL_TIMEOUT_MS })
    } finally {
      this.busy = false
    }
  }
}
