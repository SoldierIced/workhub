import { describe, expect, it } from 'vitest'
import {
  listWslDistros,
  nodeArchOfMachine,
  parseWslQuietList,
  parseWslVerboseList,
  probeWslDistro,
  WslProbeError,
  wslHostArgs,
  wslHostLaunch,
  wslHostPayload,
  type WslRun,
  type WslRunResult
} from '../src'

/** A runner that answers by the first argument after `-l`, or the probe. */
function runner(answers: Record<string, WslRunResult | Error>): WslRun & { calls: string[][] } {
  const calls: string[][] = []
  const run = async (args: string[]) => {
    calls.push(args)
    const answer = answers[args.join(' ')]
    if (!answer) throw new Error(`unexpected run: ${args.join(' ')}`)
    if (answer instanceof Error) throw answer
    return answer
  }
  return Object.assign(run, { calls })
}

const VERBOSE = '  NAME            STATE           VERSION\r\n* Ubuntu-24.04    Running         2\r\n  Debian          Stopped         2\r\n  legacy          Stopped         1\r\n'

describe('parsing the distribution lists', () => {
  it('reads the names of -l -q and leaves out what cannot be one', () => {
    expect(parseWslQuietList('Ubuntu-24.04\r\nDebian\r\n\r\n')).toEqual(['Ubuntu-24.04', 'Debian'])
    expect(parseWslQuietList('Windows Subsystem for Linux has no installed distributions.\r\nUse wsl.exe --install to install.\r\n')).toEqual([])
    expect(parseWslQuietList('')).toEqual([])
    // A BOM and NUL padding left in the text do not hide a name.
    expect(parseWslQuietList('\uFEFFUbuntu\r\nDebian\u0000\u0000\r\n')).toEqual(['Ubuntu', 'Debian'])
  })

  it('reads the default, state and version of -l -v', () => {
    expect(parseWslVerboseList(VERBOSE)).toEqual([
      { name: 'Ubuntu-24.04', isDefault: true, state: 'Running', version: 2 },
      { name: 'Debian', isDefault: false, state: 'Stopped', version: 2 },
      { name: 'legacy', isDefault: false, state: 'Stopped', version: 1 }
    ])
    expect(parseWslVerboseList('*Ubuntu Running 2')).toEqual([{ name: 'Ubuntu', isDefault: true, state: 'Running', version: 2 }])
    // A state of more than one word (a translated WSL), and rows that are not one.
    expect(parseWslVerboseList('* Ubuntu    En ejecución   2\n  Debian Detenido 2')).toEqual([
      { name: 'Ubuntu', isDefault: true, state: 'En ejecución', version: 2 },
      { name: 'Debian', isDefault: false, state: 'Detenido', version: 2 }
    ])
    expect(parseWslVerboseList('Ubuntu 2\n* Running 2\nUbuntu Running two\n' + 'a '.repeat(5000) + 'b')).toEqual([])
  })
})

describe('listWslDistros', () => {
  it('lists the distributions with their default and state', async () => {
    const run = runner({
      '-l -q': { code: 0, stdout: 'Ubuntu-24.04\r\nDebian\r\nlegacy\r\n' },
      '-l -v': { code: 0, stdout: VERBOSE }
    })
    expect(await listWslDistros(run)).toEqual([
      { name: 'Ubuntu-24.04', isDefault: true, state: 'Running', version: 2 },
      { name: 'Debian', isDefault: false, state: 'Stopped', version: 2 },
      { name: 'legacy', isDefault: false, state: 'Stopped', version: 1 }
    ])
  })

  it('keeps the names when -l -v cannot be read', async () => {
    const failing = runner({ '-l -q': { code: 0, stdout: 'Ubuntu\n' }, '-l -v': { code: 1, stdout: '' } })
    expect(await listWslDistros(failing)).toEqual([{ name: 'Ubuntu', isDefault: false }])
    const throwing = runner({ '-l -q': { code: 0, stdout: 'Ubuntu\n' }, '-l -v': new Error('spawn failed') })
    expect(await listWslDistros(throwing)).toEqual([{ name: 'Ubuntu', isDefault: false }])
  })

  it('is empty without distributions or without WSL, and then asks nothing more', async () => {
    const none = runner({ '-l -q': { code: -1, stdout: 'Windows Subsystem for Linux has no installed distributions.\r\n' } })
    expect(await listWslDistros(none)).toEqual([])
    expect(none.calls).toEqual([['-l', '-q']])
    const message = runner({ '-l -q': { code: 0, stdout: 'Windows Subsystem for Linux has no installed distributions.\r\n' } })
    expect(await listWslDistros(message)).toEqual([])
    const empty = runner({ '-l -q': { code: 0, stdout: '' } })
    expect(await listWslDistros(empty)).toEqual([])
  })
})

describe('probeWslDistro', () => {
  const probe = (out: WslRunResult) => runner({ "-d Ubuntu -e sh -c uname -m; printf %s \"$HOME\"": out })

  it("reads the machine and the default user's home", async () => {
    const run = probe({ code: 0, stdout: 'x86_64\n/users/ana' })
    expect(await probeWslDistro(run, 'Ubuntu')).toEqual({ arch: 'x86_64', home: '/users/ana' })
    expect(run.calls).toEqual([['-d', 'Ubuntu', '-e', 'sh', '-c', 'uname -m; printf %s "$HOME"']])
    expect(await probeWslDistro(probe({ code: 0, stdout: 'aarch64\r\n/root\r\n' }), 'Ubuntu')).toEqual({ arch: 'aarch64', home: '/root' })
  })

  it('throws with what wsl.exe said when the distribution cannot be run, or answers oddly', async () => {
    await expect(probeWslDistro(probe({ code: -1, stdout: 'There is no distribution with the supplied name.\r\n' }), 'Ubuntu')).rejects.toThrow(/exit -1: There is no distribution/)
    await expect(probeWslDistro(probe({ code: 0, stdout: 'x86_64\n' }), 'Ubuntu')).rejects.toBeInstanceOf(WslProbeError)
    await expect(probeWslDistro(runner({}), 'bad name')).rejects.toThrow(/not a distribution name/)
  })

  it("names Node's architecture of a machine", () => {
    expect(['x86_64', 'aarch64', 'armv7l'].map(nodeArchOfMachine)).toEqual(['x64', 'arm64', null])
  })
})

describe('the host inside a distribution', () => {
  it('lives in one folder per version under the home folder', () => {
    expect(wslHostPayload('/users/ana/', '2.1.0-alpha.3')).toEqual({
      root: '/users/ana/.workhub/host',
      dir: '/users/ana/.workhub/host/2.1.0-alpha.3',
      nodePath: '/users/ana/.workhub/host/2.1.0-alpha.3/node/bin/node',
      entry: '/users/ana/.workhub/host/2.1.0-alpha.3/host.js'
    })
    expect(() => wslHostPayload('/users/ana', '../x')).toThrow()
  })

  it('can live under another root (a test install), which must be absolute', () => {
    expect(wslHostPayload('/users/ana', '2.1.0', '/users/ana/.workhub-test/host').dir).toBe('/users/ana/.workhub-test/host/2.1.0')
    expect(() => wslHostPayload('/users/ana', '2.1.0', 'relative/host')).toThrow(/absolute/)
  })

  it('gets the bundled claude as fallback and the bridge adapters and its Node on the PATH', () => {
    expect(wslHostArgs('/users/ana/.workhub/host/2.1.0', 'arm64')).toEqual([
      '--fallback-path',
      '/users/ana/.workhub/host/2.1.0/bridge/node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64',
      '--extra-path',
      '/users/ana/.workhub/host/2.1.0/bridge/node_modules/.bin',
      '--extra-path',
      '/users/ana/.workhub/host/2.1.0/node/bin'
    ])
  })

  it('starts through wsl.exe with its arguments as a list and no Windows variables', () => {
    const { nodePath, entry } = wslHostPayload('/users/ana', '2.1.0')
    expect(wslHostLaunch({ distro: 'Ubuntu', nodePath, entry, hostVersion: '2.1.0' })).toEqual({
      command: 'wsl.exe',
      args: ['-d', 'Ubuntu', '--cd', '~', '-e', nodePath, entry, '--stdio', '--host-version', '2.1.0'],
      env: { WSLENV: '' }
    })
    expect(wslHostLaunch({ distro: 'Ubuntu', nodePath, entry, hostVersion: '2.1.0', args: ['--kiro-dir', '/users/ana/.kiro'] }).args.slice(-2)).toEqual(['--kiro-dir', '/users/ana/.kiro'])
    expect(() => wslHostLaunch({ distro: 'a b', nodePath, entry, hostVersion: '2.1.0' })).toThrow()
    expect(() => wslHostLaunch({ distro: 'Ubuntu', nodePath: 'node', entry, hostVersion: '2.1.0' })).toThrow()
  })
})
