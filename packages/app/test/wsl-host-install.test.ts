import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WslRunResult } from '@workhub/core'
import { ensureWslHost, WslHostInstallError, type WslHostInstallOptions } from '../src/main/wsl-host-install'

const PAYLOAD = Buffer.from('a synthetic host payload archive')
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const NAME = 'workhub-host-2.1.0-linux-x64.tar.gz'
const BASE = 'https://github.com/acme/workhub/releases/download/v2.1.0'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'wsl-host-install-'))
  dirs.push(d)
  return d
}

/** A distribution as the install sees it through wsl.exe: whether the version is ready, what the hosts folder lists. */
function distro(over: { ready?: boolean; checkCode?: number; unpackCode?: number; placeCode?: number; entries?: string[] } = {}) {
  const state = { ready: over.ready ?? false, unpacked: null as Buffer | null, discarded: [] as string[], pruned: [] as string[], placed: [] as string[] }
  const calls: string[][] = []
  const result = (code: number, stdout = ''): WslRunResult => ({ code, stdout, stderr: code === 0 ? '' : 'tar: Unexpected EOF' })
  const run = vi.fn(async (args: string[]) => {
    calls.push(args)
    const cmd = args.slice(3)
    if (cmd[0] === 'test') return result(over.checkCode ?? (state.ready ? 0 : 1))
    if (cmd[0] === 'rm') {
      state.discarded.push(cmd[3]!)
      return result(0)
    }
    if (cmd[0] === 'ls') return result(0, `${(over.entries ?? ['2.1.0']).join('\n')}\n`)
    if (cmd[0] === 'sh' && cmd[2]!.startsWith('cd')) {
      state.pruned.push(...cmd.slice(5))
      return result(0)
    }
    if (cmd[0] === 'sh' && cmd[2]!.includes('mv')) {
      const code = over.placeCode ?? 0
      if (code === 0) {
        state.ready = true
        state.placed.push(cmd[5]!)
      }
      return result(code)
    }
    throw new Error(`unexpected run: ${args.join(' ')}`)
  })
  const runWithInput = vi.fn(async (args: string[], input: Readable) => {
    calls.push(args)
    const chunks: Buffer[] = []
    for await (const c of input) chunks.push(c as Buffer)
    state.unpacked = Buffer.concat(chunks)
    return result(over.unpackCode ?? 0)
  })
  return { state, calls, run, runWithInput }
}

function fetcher(files: Record<string, Buffer | string>) {
  return vi.fn(async (url: string) => {
    const body = files[url]
    if (body === undefined) return new Response('not found', { status: 404 })
    return new Response(typeof body === 'string' ? body : new Uint8Array(body))
  })
}

function options(d: ReturnType<typeof distro>, over: Partial<WslHostInstallOptions> = {}): WslHostInstallOptions {
  return {
    distro: 'Ubuntu',
    version: '2.1.0',
    arch: 'x64',
    home: '/users/ana',
    run: d.run,
    runWithInput: d.runWithInput,
    fetch: fetcher({}),
    cacheDir: tempDir(),
    repo: 'acme/workhub',
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...over
  }
}

describe('ensureWslHost', () => {
  it('does nothing when the version is already installed and ready', async () => {
    const d = distro({ ready: true })
    const fetch = fetcher({})
    expect(await ensureWslHost(options(d, { fetch }))).toEqual({
      root: '/users/ana/.workhub/host',
      dir: '/users/ana/.workhub/host/2.1.0',
      nodePath: '/users/ana/.workhub/host/2.1.0/node/bin/node',
      entry: '/users/ana/.workhub/host/2.1.0/host.js',
      installed: false
    })
    expect(d.calls).toEqual([['-d', 'Ubuntu', '-e', 'test', '-f', '/users/ana/.workhub/host/2.1.0/.ready']])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('installs a local payload checked against the .sha256 next to it, under another root', async () => {
    const d = distro()
    const local = tempDir()
    const file = join(local, 'my-payload.tar.gz')
    writeFileSync(file, PAYLOAD)
    writeFileSync(`${file}.sha256`, `${sha(PAYLOAD)}  my-payload.tar.gz\n`)
    const fetch = fetcher({})
    const host = await ensureWslHost(options(d, { fetch, payloadFile: file, root: '/users/ana/.workhub-test/host' }))
    expect(host).toMatchObject({ dir: '/users/ana/.workhub-test/host/2.1.0', installed: true })
    expect(fetch).not.toHaveBeenCalled()
    expect(d.state.unpacked).toEqual(PAYLOAD)
    expect(d.state.placed).toEqual(['/users/ana/.workhub-test/host/2.1.0'])
    // Unpacked into a staging folder of the same root, passed as an argument to a fixed script.
    const unpack = d.runWithInput.mock.calls[0]![0]
    expect(unpack.slice(0, 5)).toEqual(['-d', 'Ubuntu', '-e', 'sh', '-c'])
    expect(unpack[6]).toBe('sh')
    expect(unpack[7]).toMatch(/^\/users\/ana\/\.workhub-test\/host\/\.tmp-2\.1\.0-[0-9a-f]{8}$/)
    expect(unpack[5]).not.toContain(unpack[7])
  })

  it('refuses a local payload that does not match its .sha256', async () => {
    const d = distro()
    const file = join(tempDir(), NAME)
    writeFileSync(file, PAYLOAD)
    writeFileSync(`${file}.sha256`, `${'0'.repeat(64)}  ${NAME}\n`)
    await expect(ensureWslHost(options(d, { payloadFile: file }))).rejects.toThrow(/does not match its SHA-256/)
    expect(d.runWithInput).not.toHaveBeenCalled()
    expect(d.state.ready).toBe(false)
  })

  it('downloads the payload of its release, checks it, caches it per version and reuses the cache', async () => {
    const d = distro()
    const cacheDir = tempDir()
    mkdirSync(join(cacheDir, '2.0.0'))
    writeFileSync(join(cacheDir, '2.0.0', 'old.tar.gz'), 'old')
    const fetch = fetcher({ [`${BASE}/${NAME}`]: PAYLOAD, [`${BASE}/${NAME}.sha256`]: `${sha(PAYLOAD)}  ${NAME}\n` })
    expect(await ensureWslHost(options(d, { fetch, cacheDir }))).toMatchObject({ installed: true })
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([`${BASE}/${NAME}.sha256`, `${BASE}/${NAME}`])
    expect(d.state.unpacked).toEqual(PAYLOAD)
    expect(readdirSync(cacheDir)).toEqual(['2.1.0'])
    expect(readdirSync(join(cacheDir, '2.1.0')).sort()).toEqual([NAME, `${NAME}.sha256`])

    // The distribution lost it: installed again from the cache, without a download.
    const again = distro()
    const offline = fetcher({})
    expect(await ensureWslHost(options(again, { fetch: offline, cacheDir }))).toMatchObject({ installed: true })
    expect(offline).not.toHaveBeenCalled()
    expect(again.state.unpacked).toEqual(PAYLOAD)
  })

  it('downloads once for distributions installed at the same time, and both get the whole payload', async () => {
    const cacheDir = tempDir()
    const big = Buffer.alloc(64 * 1024, 7)
    // The archive arrives in pieces, so two downloads into one file would interleave.
    const slow = () =>
      new ReadableStream<Uint8Array>({
        async start(controller) {
          for (let i = 0; i < big.length; i += 4096) {
            await new Promise((r) => setTimeout(r, 0))
            controller.enqueue(new Uint8Array(big.subarray(i, i + 4096)))
          }
          controller.close()
        }
      })
    const fetch = vi.fn(async (url: string) => (url.endsWith('.sha256') ? new Response(`${sha(big)}  ${NAME}\n`) : new Response(slow())))
    const ubuntu = distro()
    const debian = distro()
    const results = await Promise.all([
      ensureWslHost(options(ubuntu, { fetch, cacheDir })),
      ensureWslHost(options(debian, { fetch, cacheDir, distro: 'Debian' }))
    ])
    expect(results.map((r) => r.installed)).toEqual([true, true])
    expect(fetch.mock.calls.filter((c) => !String(c[0]).endsWith('.sha256'))).toHaveLength(1)
    expect(ubuntu.state.unpacked).toEqual(big)
    expect(debian.state.unpacked).toEqual(big)
    expect(readdirSync(join(cacheDir, '2.1.0')).sort()).toEqual([NAME, `${NAME}.sha256`])
  })

  it('reports the download bytes, the checksum and the unpacking, and nothing when the host is there', async () => {
    const d = distro()
    const fetch = vi.fn(async (url: string) =>
      url.endsWith('.sha256') ? new Response(`${sha(PAYLOAD)}  ${NAME}\n`) : new Response(new Uint8Array(PAYLOAD), { headers: { 'content-length': String(PAYLOAD.length) } })
    )
    const onProgress = vi.fn()
    await ensureWslHost(options(d, { fetch, onProgress }))
    expect(onProgress.mock.calls.map((c) => c[0])).toEqual([
      { phase: 'downloading', received: 0, total: PAYLOAD.length },
      { phase: 'downloading', received: PAYLOAD.length, total: PAYLOAD.length },
      { phase: 'verifying' },
      { phase: 'unpacking' }
    ])

    const ready = vi.fn()
    await ensureWslHost(options(distro({ ready: true }), { onProgress: ready }))
    expect(ready).not.toHaveBeenCalled()
  })

  it('refuses a download that does not match its published checksum and marks nothing ready', async () => {
    const d = distro()
    const cacheDir = tempDir()
    const fetch = fetcher({ [`${BASE}/${NAME}`]: Buffer.from('tampered'), [`${BASE}/${NAME}.sha256`]: `${sha(PAYLOAD)}  ${NAME}\n` })
    const err = await ensureWslHost(options(d, { fetch, cacheDir })).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(WslHostInstallError)
    expect((err as Error).message).toMatch(/does not match its published SHA-256/)
    expect(d.runWithInput).not.toHaveBeenCalled()
    expect(d.state.ready).toBe(false)
    expect(existsSync(join(cacheDir, '2.1.0', NAME))).toBe(false)
    expect(existsSync(join(cacheDir, '2.1.0', `${NAME}.partial`))).toBe(false)
  })

  it('reports a release without the payload', async () => {
    await expect(ensureWslHost(options(distro()))).rejects.toThrow(/could not download .*\.sha256 \(HTTP 404\)/)
  })

  it('discards a failed unpacking and never marks it ready', async () => {
    const d = distro({ unpackCode: 2 })
    const file = join(tempDir(), NAME)
    writeFileSync(file, PAYLOAD)
    await expect(ensureWslHost(options(d, { payloadFile: file }))).rejects.toThrow(/could not unpack the host into Ubuntu \(exit 2: tar: Unexpected EOF\)/)
    expect(d.state.ready).toBe(false)
    expect(d.state.placed).toEqual([])
    expect(d.state.discarded).toEqual([d.runWithInput.mock.calls[0]![0][7]])
  })

  it('discards a payload that cannot be put in place', async () => {
    const d = distro({ placeCode: 1 })
    const file = join(tempDir(), NAME)
    writeFileSync(file, PAYLOAD)
    await expect(ensureWslHost(options(d, { payloadFile: file }))).rejects.toThrow(/could not put the host in place/)
    expect(d.state.ready).toBe(false)
    expect(d.state.discarded).toHaveLength(1)
  })

  it('does not download when wsl.exe itself fails', async () => {
    const d = distro({ checkCode: -1 })
    const fetch = fetcher({})
    await expect(ensureWslHost(options(d, { fetch }))).rejects.toThrow(/could not check the host in Ubuntu/)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('keeps the new version and the previous one, and removes the rest', async () => {
    const d = distro({ entries: ['2.1.0', '2.0.0', '.tmp-2.0.0-0a1b2c3d', '1.9.0', 'notes'] })
    const file = join(tempDir(), NAME)
    writeFileSync(file, PAYLOAD)
    await ensureWslHost(options(d, { payloadFile: file }))
    expect(d.state.pruned).toEqual(['.tmp-2.0.0-0a1b2c3d', '1.9.0'])
    expect(d.calls.find((c) => c[3] === 'ls')).toEqual(['-d', 'Ubuntu', '-e', 'ls', '-1At', '--', '/users/ana/.workhub/host'])
  })
})
