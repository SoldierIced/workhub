import { describe, expect, it } from 'vitest'
import { bundleOf, canSelfUpdate, installMacUpdate, type MacUpdateDeps } from '../src/main/mac-update'

const BUNDLE = '/Applications/Acme.app'
const ZIP = 'https://example.com/releases/download/v2.0.0/Acme-2.0.0-mac-arm64.zip'

/** An in-memory system: a folder tree of bundles, a fixed download and its checksum. */
function fakeSystem(over: { sum?: string; id?: string; renameFails?: string } = {}) {
  const dirs = new Set<string>([BUNDLE])
  const calls: string[] = []
  const deps: MacUpdateDeps = {
    download: async (url) => void calls.push(`download ${url}`),
    text: async () => `${over.sum ?? 'abc123'}  Acme-2.0.0-mac-arm64.zip\n`,
    sha256: async () => 'abc123',
    tempDir: async () => '/tmp/u',
    list: async () => ['Acme.app'],
    writable: async (path) => path === '/Applications',
    run: async (command, args) => {
      calls.push(`${command} ${args.join(' ')}`)
      if (command.endsWith('PlistBuddy')) return `${over.id ?? 'com.example.acme'}\n`
      if (command === 'ditto' && args[0] !== '-x') dirs.add(args[1]!)
      return ''
    },
    rename: async (from, to) => {
      if (from === over.renameFails) throw new Error('busy')
      if (!dirs.delete(from)) throw new Error(`missing ${from}`)
      dirs.add(to)
      calls.push(`rename ${from} -> ${to}`)
    },
    remove: async (path) => void dirs.delete(path)
  }
  return { deps, dirs, calls }
}

describe('macOS self-update', () => {
  it('finds the bundle the executable runs from', () => {
    expect(bundleOf('/Applications/Acme.app/Contents/MacOS/Acme 2')).toBe(BUNDLE)
    expect(bundleOf('/usr/local/bin/electron')).toBeNull()
  })

  it('can update itself only from a bundle in a folder it can write to', async () => {
    const { deps } = fakeSystem()
    expect(await canSelfUpdate('/Applications/Acme.app/Contents/MacOS/Acme', deps)).toBe(true)
    expect(await canSelfUpdate('/Volumes/Acme/Acme.app/Contents/MacOS/Acme', deps)).toBe(false)
    expect(await canSelfUpdate('/usr/local/bin/electron', deps)).toBe(false)
  })

  it('downloads, checks and swaps the bundle', async () => {
    const { deps, dirs, calls } = fakeSystem()
    await installMacUpdate({ zipUrl: ZIP, bundle: BUNDLE, appId: 'com.example.acme' }, deps)
    expect(calls[0]).toBe(`download ${ZIP}`)
    expect(calls).toContain(`rename ${BUNDLE} -> ${BUNDLE}.old`)
    expect(calls).toContain(`rename ${BUNDLE}.new -> ${BUNDLE}`)
    expect([...dirs]).toEqual([BUNDLE])
  })

  it('installs nothing when the checksum does not match', async () => {
    const { deps, calls } = fakeSystem({ sum: 'other' })
    await expect(installMacUpdate({ zipUrl: ZIP, bundle: BUNDLE, appId: 'com.example.acme' }, deps)).rejects.toThrow(/checksum/)
    expect(calls.some((c) => c.startsWith('rename'))).toBe(false)
  })

  it('refuses a download of another app', async () => {
    const { deps, calls } = fakeSystem({ id: 'com.example.other' })
    await expect(installMacUpdate({ zipUrl: ZIP, bundle: BUNDLE, appId: 'com.example.acme' }, deps)).rejects.toThrow(/another app/)
    expect(calls.some((c) => c.startsWith('rename'))).toBe(false)
  })

  it('puts the old bundle back when the new one cannot take its place', async () => {
    const { deps, dirs } = fakeSystem({ renameFails: `${BUNDLE}.new` })
    await expect(installMacUpdate({ zipUrl: ZIP, bundle: BUNDLE, appId: 'com.example.acme' }, deps)).rejects.toThrow('busy')
    expect(dirs.has(BUNDLE)).toBe(true)
    expect(dirs.has(`${BUNDLE}.old`)).toBe(false)
  })
})
