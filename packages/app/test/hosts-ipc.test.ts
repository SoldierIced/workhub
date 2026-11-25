import { describe, expect, it, vi } from 'vitest'
import type { WslRun } from '@workhub/core'
import { HostStatusBoard, reduceHostStatus } from '../src/main/host-status'
import { registerHostsIpc, wslDistros } from '../src/main/ipc/hosts'
import type { HostStatus } from '../src/shared/hosts-api'

const run: WslRun = vi.fn(async (args: string[]) =>
  args.includes('-q') ? { code: 0, stdout: 'Ubuntu-22.04\r\nDebian\r\n' } : { code: 0, stdout: '  NAME            STATE           VERSION\r\n* Ubuntu-22.04    Running         2\r\n  Debian          Stopped         2\r\n' }
)

function registered(deps: Parameters<typeof registerHostsIpc>[1]) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  registerHostsIpc({ handle: (channel, fn) => handlers.set(channel, (...args) => fn({} as never, ...args)), on: () => undefined }, deps)
  return handlers
}

describe('hosts IPC', () => {
  it('lists the WSL distributions on Windows, the default one marked', async () => {
    expect(await wslDistros('win32', run)).toEqual({
      distros: [
        { name: 'Ubuntu-22.04', isDefault: true, state: 'Running', version: 2 },
        { name: 'Debian', isDefault: false, state: 'Stopped', version: 2 }
      ]
    })
  })

  it('lists none off Windows without running wsl.exe, and says why', async () => {
    const never = vi.fn<WslRun>()
    expect(await wslDistros('linux', never)).toEqual({ distros: [], reason: 'notWindows' })
    expect(await wslDistros('darwin', never)).toEqual({ distros: [], reason: 'notWindows' })
    expect(never).not.toHaveBeenCalled()
  })

  it('says when WSL has no distribution or is not there', async () => {
    expect(await wslDistros('win32', async () => ({ code: 0, stdout: '' }))).toEqual({ distros: [], reason: 'none' })
    expect(await wslDistros('win32', async () => ({ code: 1, stdout: '' }))).toEqual({ distros: [], reason: 'none' })
    expect(await wslDistros('win32', async () => Promise.reject(new Error('wsl.exe not found')))).toEqual({ distros: [], reason: 'none' })
  })

  it('serves the statuses and retries only a host id given as text', async () => {
    const retry = vi.fn((id: string) => id === 'wsl:Ubuntu')
    const statuses: HostStatus[] = [{ id: 'local', kind: 'local', state: 'connected' }]
    const handlers = registered({ platform: 'linux', run, statuses: () => statuses, retry })
    expect(await handlers.get('hosts:status')!()).toBe(statuses)
    expect(await handlers.get('hosts:wslDistros')!()).toEqual({ distros: [], reason: 'notWindows' })
    expect(await handlers.get('hosts:retry')!('wsl:Ubuntu')).toBe(true)
    expect(await handlers.get('hosts:retry')!({ id: 'wsl:Ubuntu' })).toBe(false)
    expect(retry).toHaveBeenCalledTimes(1)
  })
})

describe('host status', () => {
  it('moves through connecting, installing, connected, lost and failed', () => {
    const id = 'wsl:Ubuntu'
    let s = reduceHostStatus(undefined, id, { type: 'connecting' })
    expect(s).toEqual({ id, kind: 'wsl', state: 'connecting' })
    s = reduceHostStatus(s, id, { type: 'installing', progress: { phase: 'downloading', received: 10, total: 100 } })
    expect(s).toEqual({ id, kind: 'wsl', state: 'installing', installProgress: { phase: 'downloading', received: 10, total: 100 } })
    s = reduceHostStatus(s, id, { type: 'connected', control: true })
    expect(s).toEqual({ id, kind: 'wsl', state: 'connected' })
    s = reduceHostStatus(s, id, { type: 'lost', reason: 'the host process exited (1)', restarting: true })
    expect(s).toEqual({ id, kind: 'wsl', state: 'connecting', detail: 'the host process exited (1)' })
    s = reduceHostStatus(s, id, { type: 'lost', reason: 'incompatible host', restarting: false })
    expect(s).toEqual({ id, kind: 'wsl', state: 'failed', detail: 'incompatible host' })
    // A retry starts over: the reason of the failure is gone.
    expect(reduceHostStatus(s, id, { type: 'connecting' })).toEqual({ id, kind: 'wsl', state: 'connecting' })
    expect(reduceHostStatus(s, id, { type: 'connected', control: false })).toEqual({ id, kind: 'wsl', state: 'connected', warning: 'noControl' })
  })

  it('lists this computer first and sends the list only when a status changes', () => {
    const emit = vi.fn()
    const board = new HostStatusBoard(emit)
    expect(board.list()).toEqual([{ id: 'local', kind: 'local', state: 'connected' }])
    board.apply('wsl:Ubuntu', { type: 'unavailable', detail: 'not on Windows' })
    board.apply('wsl:Ubuntu', { type: 'unavailable', detail: 'not on Windows' })
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit.mock.lastCall![0].map((h: HostStatus) => `${h.id} ${h.state}`)).toEqual(['local connected', 'wsl:Ubuntu unavailable'])
  })
})
