import { describe, expect, it, vi } from 'vitest'
import { wslHostPayload, type HostLaunch, type WslRun } from '@workhub/core'
import type { SessionHost } from '../src/main/hosts'
import { HostStatusBoard } from '../src/main/host-status'
import { WSL_HELLO_TIMEOUT_MS, WSL_NOT_WINDOWS, WslHosts, wslDistrosOf, type WslHostInstall, type WslHostsDeps } from '../src/main/wsl-hosts'
import type { HostProcessOptions } from '../src/main/host-process'

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise<void>((r) => setImmediate(r))
}

function setup(over: Partial<WslHostsDeps> & { failConnect?: string[]; homes?: Record<string, string>; machine?: string; control?: null } = {}) {
  const homes = over.homes ?? { Ubuntu: '/users/ana', Debian: '/users/ana' }
  const run: WslRun = vi.fn(async (args: string[]) => {
    const home = homes[args[1]!]
    return home ? { code: 0, stdout: `${over.machine ?? 'x86_64'}\n${home}` } : { code: 1, stdout: '', stderr: 'There is no distribution with the supplied name.' }
  })
  // A run with a timeout, each one the same fake: the timeouts asked for are kept.
  const timeouts: number[] = []
  const runner = vi.fn((timeoutMs: number) => {
    timeouts.push(timeoutMs)
    const timed: WslRun = (args) => run(args)
    return timed
  })
  const install = vi.fn<WslHostInstall>(async ({ home }) => wslHostPayload(home, '2.1.0'))
  const created: { id?: string; launch: HostLaunch; stopped: boolean; helloTimeoutMs?: number }[] = []
  const lifecycles: Pick<HostProcessOptions, 'onRestart' | 'onLost'>[] = []
  const board = new HostStatusBoard()
  const registered: SessionHost[] = []
  const log = { info: vi.fn<(m: string) => void>(), warn: vi.fn<(m: string) => void>(), error: vi.fn<(m: string) => void>() }
  const hosts = new WslHosts({
    platform: 'win32',
    hostVersion: '2.1.0',
    run,
    runner,
    install,
    register: (h) => registered.push(h),
    log,
    status: (id, event) => board.apply(id, event),
    createProcess: (options) => {
      const entry = { id: options.id, launch: options.launch!(), stopped: false, helloTimeoutMs: options.helloTimeoutMs }
      created.push(entry)
      lifecycles.push({ onRestart: options.onRestart, onLost: options.onLost })
      return {
        connect: async () => {
          if (over.failConnect?.includes(options.id!)) throw new Error('the host process exited (1)')
          return { id: options.id!, ...(over.control === null ? { control: null } : {}) } as SessionHost
        },
        stop: () => {
          entry.stopped = true
        }
      }
    },
    ...over
  })
  return { hosts, run, runner, timeouts, install, created, registered, log, board, lifecycles }
}

describe('WslHosts', () => {
  it('names each distribution once, in order', () => {
    expect(wslDistrosOf([{ kind: 'local' }, undefined, { kind: 'wsl', distro: 'Ubuntu' }, { kind: 'wsl', distro: 'Debian' }, { kind: 'wsl', distro: 'Ubuntu' }])).toEqual(['Ubuntu', 'Debian'])
  })

  it('installs the host, starts one per distribution through wsl.exe with the Linux flags, and registers it', async () => {
    const { hosts, created, registered, log, install } = setup()
    hosts.ensure([{ kind: 'wsl', distro: 'Ubuntu' }, { kind: 'local' }])
    hosts.ensure([{ kind: 'wsl', distro: 'Ubuntu' }])
    await flush()
    expect(created).toEqual([
      {
        id: 'wsl:Ubuntu',
        stopped: false,
        helloTimeoutMs: WSL_HELLO_TIMEOUT_MS,
        launch: {
          command: 'wsl.exe',
          args: [
            '-d',
            'Ubuntu',
            '--cd',
            '~',
            '-e',
            '/users/ana/.workhub/host/2.1.0/node/bin/node',
            '/users/ana/.workhub/host/2.1.0/host.js',
            '--stdio',
            '--host-version',
            '2.1.0',
            '--fallback-path',
            '/users/ana/.workhub/host/2.1.0/bridge/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64',
            '--extra-path',
            '/users/ana/.workhub/host/2.1.0/bridge/node_modules/.bin',
            '--extra-path',
            '/users/ana/.workhub/host/2.1.0/node/bin'
          ],
          env: { WSLENV: '' }
        }
      }
    ])
    expect(install).toHaveBeenCalledWith({ distro: 'Ubuntu', home: '/users/ana', arch: 'x64', run: expect.any(Function), onProgress: expect.any(Function) })
    expect(registered.map((h) => h.id)).toEqual(['wsl:Ubuntu'])
    // Its home is the distribution's (what `~` means there).
    expect(registered[0]!.home).toBe('/users/ana')
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('host wsl:Ubuntu: connected'))

    hosts.ensure([{ kind: 'wsl', distro: 'Debian' }])
    await flush()
    expect(registered.map((h) => h.id)).toEqual(['wsl:Ubuntu', 'wsl:Debian'])
    hosts.stop()
    expect(created.map((c) => c.stopped)).toEqual([true, true])
  })

  it('gives the first calls into a distribution (the probe and the install) as long as a cold start takes', async () => {
    const { hosts, runner, timeouts, install } = setup()
    hosts.ensure([{ kind: 'wsl', distro: 'Ubuntu' }])
    await flush()
    // The probe is the first wsl.exe call: a stopped distribution boots during it.
    expect(timeouts.length).toBeGreaterThan(0)
    for (const t of timeouts) expect(t).toBeGreaterThanOrEqual(WSL_HELLO_TIMEOUT_MS)
    // The install's own first check runs with such a runner too.
    const target = install.mock.calls[0]![0]
    expect(target.run).toBe(vi.mocked(runner).mock.results.at(-1)!.value)
  })

  it('logs where the host was expected when it cannot connect, and that the sessions of its profiles cannot start', async () => {
    const { hosts, registered, log } = setup({ failConnect: ['wsl:Ubuntu'] })
    hosts.ensure([{ kind: 'wsl', distro: 'Ubuntu' }])
    await flush()
    expect(registered).toEqual([])
    expect(log.error).toHaveBeenCalledWith('host wsl:Ubuntu: not available (the host is expected at /users/ana/.workhub/host/2.1.0): the host process exited (1); the sessions of its profiles cannot start')
  })

  it('starts nothing when the install fails, and says why', async () => {
    const install = vi.fn<WslHostInstall>(async () => {
      throw new Error('could not unpack the host into Ubuntu (exit 2: tar: Unexpected EOF)')
    })
    const { hosts, created, registered, log } = setup({ install })
    hosts.ensure([{ kind: 'wsl', distro: 'Ubuntu' }])
    await flush()
    expect(created).toEqual([])
    expect(registered).toEqual([])
    expect(log.error).toHaveBeenCalledWith('host wsl:Ubuntu: could not unpack the host into Ubuntu (exit 2: tar: Unexpected EOF); the sessions of its profiles cannot start')
  })

  it('installs nothing in a distribution whose processor has no host build', async () => {
    const { hosts, created, install, log } = setup({ machine: 'riscv64' })
    hosts.ensure([{ kind: 'wsl', distro: 'Ubuntu' }])
    await flush()
    expect(install).not.toHaveBeenCalled()
    expect(created).toEqual([])
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('no host is built for its processor (riscv64)'))
  })

  it('starts nothing for a distribution that cannot be read, and tries it once', async () => {
    const { hosts, created, run, log } = setup({ homes: {} })
    hosts.ensure([{ kind: 'wsl', distro: 'Gone' }])
    hosts.ensure([{ kind: 'wsl', distro: 'Gone' }])
    await flush()
    expect(created).toEqual([])
    expect(run).toHaveBeenCalledTimes(1)
    expect(log.error).toHaveBeenCalledWith(expect.stringMatching(/^host wsl:Gone: could not read WSL distribution Gone: exit 1: There is no distribution .*; the sessions of its profiles cannot start$/))
  })

  it('starts nothing off Windows, and says so once', async () => {
    const { hosts, created, run, log } = setup({ platform: 'linux' })
    hosts.ensure([{ kind: 'wsl', distro: 'Ubuntu' }])
    hosts.ensure([{ kind: 'wsl', distro: 'Ubuntu' }])
    await flush()
    expect(created).toEqual([])
    expect(run).not.toHaveBeenCalled()
    expect(log.warn).toHaveBeenCalledTimes(1)
  })

  it('reports connecting, the install steps and connected, and warns about a host without a control endpoint', async () => {
    const seen: string[] = []
    const install = vi.fn<WslHostInstall>(async ({ home, onProgress }) => {
      onProgress({ phase: 'downloading', received: 0, total: 100 })
      onProgress({ phase: 'unpacking' })
      return wslHostPayload(home, '2.1.0')
    })
    const { hosts, board, log } = setup({ install, control: null, status: (id, e) => seen.push(`${id} ${e.type}`) })
    hosts.ensure([{ kind: 'wsl', distro: 'Ubuntu' }])
    await flush()
    expect(seen).toEqual(['wsl:Ubuntu connecting', 'wsl:Ubuntu installing', 'wsl:Ubuntu installing', 'wsl:Ubuntu connecting', 'wsl:Ubuntu connected'])
    expect(board.get('wsl:Ubuntu')).toBeUndefined()
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('without a control endpoint'))
  })

  it('reports a failure with its reason, and retries a failed distribution on request only', async () => {
    const { hosts, board, created, registered } = setup({ failConnect: ['wsl:Ubuntu'] })
    hosts.ensure([{ kind: 'wsl', distro: 'Ubuntu' }])
    await flush()
    expect(board.get('wsl:Ubuntu')).toEqual({ id: 'wsl:Ubuntu', kind: 'wsl', state: 'failed', detail: 'the host process exited (1)' })
    expect(created.map((c) => c.stopped)).toEqual([true])
    expect(hosts.retry('wsl:Debian')).toBe(false)
    expect(hosts.retry('local')).toBe(false)

    expect(hosts.retry('wsl:Ubuntu')).toBe(true)
    // Already trying: a second retry is refused until it fails again.
    expect(hosts.retry('wsl:Ubuntu')).toBe(false)
    await flush()
    expect(created).toHaveLength(2)
    expect(board.get('wsl:Ubuntu')?.state).toBe('failed')
    expect(registered).toEqual([])
  })

  it('follows a connected host that is lost, restarted or given up on', async () => {
    const { hosts, board, lifecycles } = setup()
    hosts.ensure([{ kind: 'wsl', distro: 'Ubuntu' }])
    await flush()
    expect(board.get('wsl:Ubuntu')).toEqual({ id: 'wsl:Ubuntu', kind: 'wsl', state: 'connected' })
    const { onLost, onRestart } = lifecycles[0]!
    onLost!('the host process exited (1)', true)
    expect(board.get('wsl:Ubuntu')).toMatchObject({ state: 'connecting', detail: 'the host process exited (1)' })
    expect(hosts.retry('wsl:Ubuntu')).toBe(false)
    onRestart!({ id: 'wsl:Ubuntu' } as SessionHost)
    expect(board.get('wsl:Ubuntu')).toEqual({ id: 'wsl:Ubuntu', kind: 'wsl', state: 'connected' })
    onLost!('incompatible host', false)
    expect(board.get('wsl:Ubuntu')).toMatchObject({ state: 'failed', detail: 'incompatible host' })
    expect(hosts.retry('wsl:Ubuntu')).toBe(true)
    hosts.stop()
  })

  it('reports the distributions as unavailable off Windows, and never retries them', async () => {
    const { hosts, board } = setup({ platform: 'linux' })
    hosts.ensure([{ kind: 'wsl', distro: 'Ubuntu' }])
    expect(board.get('wsl:Ubuntu')).toEqual({ id: 'wsl:Ubuntu', kind: 'wsl', state: 'unavailable', detail: WSL_NOT_WINDOWS })
    expect(hosts.retry('wsl:Ubuntu')).toBe(false)
  })
})

describe('WslHosts.toolProbe', () => {
  it('has no probe until the host of the distribution is installed, then runs the setup checks inside it', async () => {
    const { hosts, run } = setup()
    expect(hosts.toolProbe('Ubuntu')).toBeNull()
    hosts.ensure([{ kind: 'wsl', distro: 'Ubuntu' }])
    await flush()
    const probe = hosts.toolProbe('Ubuntu')!
    const runs = vi.mocked(run)
    runs.mockImplementation(async (args) => (args.includes('git') ? { code: 1, stdout: '', stderr: 'execvpe(git) failed: No such file or directory' } : { code: 0, stdout: '2.1.0 (Claude Code)\n' }))
    expect(await probe('claude')).toEqual({ result: 'ok', output: '2.1.0 (Claude Code)' })
    expect(runs.mock.calls.at(-1)![0]).toEqual(['-d', 'Ubuntu', '-e', '/users/ana/.workhub/host/2.1.0/bridge/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude', '--version'])
    await probe('auth')
    expect(runs.mock.calls.at(-1)![0].slice(-2)).toEqual(['auth', 'status'])
    expect(await probe('git')).toEqual({ result: 'notFound', output: 'execvpe(git) failed: No such file or directory' })
    expect(runs.mock.calls.at(-1)![0]).toEqual(['-d', 'Ubuntu', '-e', 'git', '--version'])
    runs.mockImplementation(async () => ({ code: -1, stdout: '' }))
    expect((await probe('git')).result).toBe('timeout')
  })
})
