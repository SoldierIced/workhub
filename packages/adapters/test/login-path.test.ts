import { describe, expect, it } from 'vitest'
import { BUILTIN_AGENTS } from '@workhub/core'
import type * as nodePty from 'node-pty'
import { TerminalRuntime } from '../src/agent-terminal'
import { augmentedPath, parsePrintedPath, PRINT_PATH_COMMAND, readLoginShellPath } from '../src/shared/login-path'

const launchd = '/usr/bin:/bin:/usr/sbin:/sbin'

describe('parsePrintedPath', () => {
  it('reads the PATH between the markers and ignores profile banners around it', () => {
    expect(parsePrintedPath('Welcome!\n__WORKHUB_PATH__/opt/homebrew/bin:/usr/bin__WORKHUB_PATH__\nbye')).toBe('/opt/homebrew/bin:/usr/bin')
    expect(parsePrintedPath('no markers here')).toBeNull()
    expect(parsePrintedPath('__WORKHUB_PATH__/usr/bin')).toBeNull()
    expect(parsePrintedPath('__WORKHUB_PATH____WORKHUB_PATH__')).toBeNull()
  })
})

describe('augmentedPath', () => {
  it('puts the login shell PATH first, then the inherited one, then the usual CLI folders, without duplicates', () => {
    expect(augmentedPath({ platform: 'darwin', inherited: launchd, loginShell: '/Users/dana/.nvm/bin:/opt/homebrew/bin:/usr/bin', home: '/Users/dana' })).toBe(
      '/Users/dana/.nvm/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/Users/dana/.local/bin'
    )
  })
  it('falls back to the inherited PATH plus the usual CLI folders without a login shell PATH', () => {
    expect(augmentedPath({ platform: 'darwin', inherited: launchd, loginShell: null, home: '/Users/dana' })).toBe(`${launchd}:/opt/homebrew/bin:/usr/local/bin:/Users/dana/.local/bin`)
    expect(augmentedPath({ platform: 'linux', inherited: undefined, loginShell: null, home: '/home/dana' })).toBe('/usr/local/bin:/home/linuxbrew/.linuxbrew/bin:/home/dana/.local/bin')
  })
  it('leaves Windows alone', () => {
    expect(augmentedPath({ platform: 'win32', inherited: 'C:\\Windows;C:\\Tools', loginShell: '/usr/bin' })).toBe('C:\\Windows;C:\\Tools')
  })
})

describe('readLoginShellPath', () => {
  it('runs the login shell interactively with a timeout and parses its output', async () => {
    const calls: [string, string[], number][] = []
    const path = await readLoginShellPath({
      platform: 'darwin',
      shell: '/bin/zsh',
      timeoutMs: 1234,
      run: async (shell, args, timeoutMs) => (calls.push([shell, args, timeoutMs]), 'motd\n__WORKHUB_PATH__/opt/homebrew/bin:/usr/bin__WORKHUB_PATH__')
    })
    expect(path).toBe('/opt/homebrew/bin:/usr/bin')
    expect(calls).toEqual([['/bin/zsh', ['-ilc', PRINT_PATH_COMMAND], 1234]])
  })
  it('gives null on a failure or a timeout, and never runs a shell on Windows', async () => {
    expect(await readLoginShellPath({ platform: 'linux', shell: '/bin/bash', run: async () => Promise.reject(new Error('timed out')) })).toBeNull()
    let ran = false
    expect(await readLoginShellPath({ platform: 'win32', run: async () => ((ran = true), '') })).toBeNull()
    expect(ran).toBe(false)
  })
  it.skipIf(process.platform === 'win32')('reads a real shell', async () => {
    expect(await readLoginShellPath({ shell: '/bin/sh' })).toBeTruthy()
  })
})

describe('TerminalRuntime PATH', () => {
  it('starts a session with the given PATH and the fallback folders last', async () => {
    let env: Record<string, string> | undefined
    const fakePty = { onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), kill() {}, write() {}, resize() {} }
    const spawn = ((_file: string, _args: string[], options: { env?: Record<string, string> }) => ((env = options.env), fakePty)) as unknown as typeof nodePty.spawn
    const rt = new TerminalRuntime({ spawn, path: () => '/opt/homebrew/bin:/usr/bin', fallbackPath: ['/bundle/claude'] })
    const shell = BUILTIN_AGENTS.find((a) => a.id === 'shell')!
    await rt.start({ sessionId: 'p1', agent: shell, account: null, cwd: process.cwd(), env: { ACME: '1' } })
    const key = Object.keys(env!).find((k) => k.toUpperCase() === 'PATH')!
    const sep = process.platform === 'win32' ? ';' : ':'
    expect(env![key]).toBe(['/opt/homebrew/bin:/usr/bin', '/bundle/claude'].join(sep))
    expect(env!['ACME']).toBe('1')
  })
})
