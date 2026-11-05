import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bundleOf, canSelfUpdate, downloadFile, installMacUpdate, type MacUpdateDeps } from '../src/main/mac-update'

const BUNDLE = '/Applications/Acme.app'
const ZIP = 'https://example.com/releases/download/v2.0.0/Acme-2.0.0-mac-arm64.zip'

/** An in-memory system: a folder tree of bundles, a fixed download and its checksum. */
function fakeSystem(over: { sum?: string; id?: string; renameFails?: RegExp[]; removeFails?: (string | RegExp)[]; leftovers?: string[] } = {}) {
  const dirs = new Set<string>([BUNDLE, '/tmp/u', ...(over.leftovers ?? [])])
  const calls: string[] = []
  const deps: MacUpdateDeps = {
    download: async (url) => void calls.push(`download ${url}`),
    text: async () => `${over.sum ?? 'abc123'}  Acme-2.0.0-mac-arm64.zip\n`,
    sha256: async () => 'abc123',
    tempDir: async () => '/tmp/u',
    // /Applications lists what the fake holds there; the unpacked download holds the app.
    list: async (dir) => (dir === '/Applications' ? [...dirs].filter((d) => d.startsWith('/Applications/')).map((d) => d.slice('/Applications/'.length)) : ['Acme.app']),
    writable: async (path) => path === '/Applications',
    run: async (command, args) => {
      calls.push(`${command} ${args.join(' ')}`)
      if (command.endsWith('PlistBuddy')) return `${over.id ?? 'com.example.acme'}\n`
      if (command === 'ditto' && args[0] !== '-x') dirs.add(args[1]!)
      return ''
    },
    rename: async (from, to) => {
      if (over.renameFails?.some((r) => r.test(from))) throw new Error(`busy ${from}`)
      if (!dirs.delete(from)) throw new Error(`missing ${from}`)
      dirs.add(to)
      calls.push(`rename ${from} -> ${to}`)
    },
    remove: async (path) => {
      if (over.removeFails?.some((r) => (typeof r === 'string' ? r === path : r.test(path))) && dirs.has(path)) throw new Error(`ENOTEMPTY: directory not empty, rmdir '${path}'`)
      dirs.delete(path)
    }
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
    expect(calls.some((c) => /^rename \/Applications\/Acme\.app -> \/Applications\/Acme\.app\.old-[0-9a-f]{8}$/.test(c))).toBe(true)
    expect(calls.some((c) => /^rename \/Applications\/Acme\.app\.new-[0-9a-f]{8} -> \/Applications\/Acme\.app$/.test(c))).toBe(true)
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
    const { deps, dirs } = fakeSystem({ renameFails: [/\.new-/] })
    await expect(installMacUpdate({ zipUrl: ZIP, bundle: BUNDLE, appId: 'com.example.acme' }, deps)).rejects.toThrow('busy')
    // The old bundle is back and the unpacked new one is not left behind.
    expect([...dirs]).toEqual([BUNDLE])
  })

  it('reports success when only the clean-up of the old bundle and the download fails', async () => {
    const { deps, dirs, calls } = fakeSystem({ removeFails: [/\.old-/, '/tmp/u'] })
    await expect(installMacUpdate({ zipUrl: ZIP, bundle: BUNDLE, appId: 'com.example.acme' }, deps)).resolves.toBeUndefined()
    expect(calls.some((c) => /\.new-[0-9a-f]{8} -> \/Applications\/Acme\.app$/.test(c))).toBe(true)
    expect(dirs.has(BUNDLE)).toBe(true)
  })

  it('is not blocked by leftovers of earlier updates that cannot be removed, and tidies the others', async () => {
    const stuck = `${BUNDLE}.old`
    const { deps, dirs } = fakeSystem({ leftovers: [stuck, `${BUNDLE}.new`, `${BUNDLE}.old-0badc0de`, '/Applications/Other.app.old'], removeFails: [stuck] })
    await expect(installMacUpdate({ zipUrl: ZIP, bundle: BUNDLE, appId: 'com.example.acme' }, deps)).resolves.toBeUndefined()
    expect([...dirs].sort()).toEqual([BUNDLE, stuck, '/Applications/Other.app.old'].sort())
  })

  it('removes the copy of the new version when the running bundle cannot be moved aside', async () => {
    const { deps, dirs } = fakeSystem({ renameFails: [/^\/Applications\/Acme\.app$/] })
    await expect(installMacUpdate({ zipUrl: ZIP, bundle: BUNDLE, appId: 'com.example.acme' }, deps)).rejects.toThrow('busy')
    expect([...dirs]).toEqual([BUNDLE])
  })

  it('names both bundles when the swap and putting the old one back both fail', async () => {
    const { deps } = fakeSystem({ renameFails: [/\.new-/, /\.old-/] })
    const err: Error = await installMacUpdate({ zipUrl: ZIP, bundle: BUNDLE, appId: 'com.example.acme' }, deps).then(
      () => new Error('resolved'),
      (e: Error) => e
    )
    expect(err.message).toMatch(/could not be put back/)
    expect(err.message).toMatch(/previous version is at \/Applications\/Acme\.app\.old-[0-9a-f]{8}/)
    expect(err.message).toMatch(/new one at \/Applications\/Acme\.app\.new-[0-9a-f]{8}/)
  })
})

describe('downloadFile', () => {
  const body = (chunks: Uint8Array[], stall: boolean) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(c)
        if (!stall) controller.close()
      }
    })

  it('writes the body to the file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'workhub-dl-'))
    try {
      const file = join(dir, 'u.zip')
      const fake = (async () => new Response(body([new TextEncoder().encode('zip')], false))) as unknown as typeof fetch
      await downloadFile('https://example.com/u.zip', file, { fetch: fake })
      expect(readFileSync(file, 'utf8')).toBe('zip')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('gives up on a server that does not answer', async () => {
    const hang = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)))) as unknown as typeof fetch
    await expect(downloadFile('https://example.com/u.zip', join(tmpdir(), 'never.zip'), { fetch: hang, connectMs: 20 })).rejects.toThrow(/did not answer/)
  })

  it('gives up on a download that stops sending', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'workhub-dl-'))
    try {
      const stalls = (async () => new Response(body([new Uint8Array([1, 2, 3])], true))) as unknown as typeof fetch
      await expect(downloadFile('https://example.com/u.zip', join(dir, 'u.zip'), { fetch: stalls, idleMs: 30 })).rejects.toThrow(/stalled/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
