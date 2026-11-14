import { describe, expect, it } from 'vitest'
import { INSTALLERS } from '@workhub/core'
import { registerSetupInstallIpc } from '../src/main/setup-ipc'
import { INSTALL_OUTPUT_CAP, runInShell, SetupInstaller } from '../src/main/setup-install'

describe('SetupInstaller', () => {
  it('runs only the table command for the platform', async () => {
    const seen: string[] = []
    const installer = new SetupInstaller({ platform: 'linux', run: async (command) => (seen.push(command), { ok: true, output: 'done' }) })
    expect(await installer.install('claudeCode')).toEqual({ ok: true, output: 'done' })
    expect(seen).toEqual([INSTALLERS.claudeCode.linux])
  })
  it('refuses unknown ids, free-form commands and platforms without an installer', async () => {
    const seen: string[] = []
    const installer = new SetupInstaller({ platform: 'linux', run: async (c) => (seen.push(c), { ok: true, output: '' }) })
    for (const bad of ['rm -rf /', 'toString', 42, null, undefined]) expect((await installer.install(bad)).ok).toBe(false)
    expect((await installer.install('github')).ok).toBe(false)
    expect(seen).toEqual([])
  })
  it('allows one install at a time', async () => {
    let release = () => {}
    const installer = new SetupInstaller({ platform: 'darwin', run: () => new Promise((r) => (release = () => r({ ok: true, output: '' }))) })
    const first = installer.install('codex')
    expect((await installer.install('kiro')).ok).toBe(false)
    release()
    expect((await first).ok).toBe(true)
    release = () => {}
    const again = installer.install('kiro')
    release()
    expect((await again).ok).toBe(true)
  })
  it('caps the output of a real shell run and reports failure', async () => {
    if (process.platform === 'win32') return
    const noisy = await runInShell(`node -e "process.stdout.write('x'.repeat(10000))"`, { platform: process.platform, timeoutMs: 20_000 })
    expect(noisy.ok).toBe(true)
    expect(noisy.output.length).toBe(INSTALL_OUTPUT_CAP)
    expect(await runInShell('echo boom; exit 3', { platform: process.platform, timeoutMs: 20_000 })).toMatchObject({ ok: false, output: expect.stringContaining('boom') })
  })
})

describe('registerSetupInstallIpc', () => {
  it('registers setup:install and passes only the installer id on', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const got: unknown[] = []
    registerSetupInstallIpc({ handle: (c, l) => void handlers.set(c, l as never), on: () => undefined }, { install: async (id) => (got.push(id), { ok: true, output: '' }) })
    await handlers.get('setup:install')!({}, 'codex', 'ignored extra')
    expect(got).toEqual(['codex'])
  })
})
