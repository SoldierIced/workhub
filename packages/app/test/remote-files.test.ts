import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RemoteRefused } from '../src/main/remote'
import { readRemoteFile, resolveRemoteFile } from '../src/main/remote/files'

let base: string
let folder: string
let outside: string

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'remote-files-'))
  folder = join(base, 'project')
  outside = join(base, 'outside')
  await mkdir(join(folder, 'out'), { recursive: true })
  await mkdir(join(folder, '.ssh'), { recursive: true })
  await mkdir(outside, { recursive: true })
  await writeFile(join(folder, 'out', 'chart.png'), 'png-bytes')
  await writeFile(join(folder, '.env'), 'TOKEN=x')
  await writeFile(join(folder, '.ssh', 'config'), 'Host x')
  await writeFile(join(folder, 'id_ed25519'), 'key')
  await writeFile(join(folder, 'server.pem'), 'cert')
  await writeFile(join(folder, 'tls.KEY'), 'key')
  await writeFile(join(outside, 'secret.txt'), 'outside')
  await symlink(join(outside, 'secret.txt'), join(folder, 'link.txt'))
  await symlink(outside, join(folder, 'linked-dir'))
  await symlink(join(folder, '.env'), join(folder, 'env.txt'))
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

describe('remote files', () => {
  it('reads a file inside the folder, by relative or absolute path', async () => {
    const file = await readRemoteFile(folder, 'out/chart.png')
    expect(file).toMatchObject({ name: 'chart.png', mime: 'image/png', data: Buffer.from('png-bytes').toString('base64') })
    await expect(readRemoteFile(folder, join(folder, 'out', 'chart.png'))).resolves.toMatchObject({ name: 'chart.png' })
  })

  it('refuses paths outside the folder, as typed', async () => {
    await expect(resolveRemoteFile(folder, '../outside/secret.txt')).rejects.toThrow(/not in the session folder/)
    await expect(resolveRemoteFile(folder, join(outside, 'secret.txt'))).rejects.toThrow(/not in the session folder/)
    await expect(resolveRemoteFile(folder, '.')).rejects.toThrow(/not in the session folder/)
  })

  it('refuses symlinks that lead outside the folder or to a secret', async () => {
    await expect(readRemoteFile(folder, 'link.txt')).rejects.toThrow(/not in the session folder/)
    await expect(readRemoteFile(folder, 'linked-dir/secret.txt')).rejects.toThrow(/not in the session folder/)
    await expect(readRemoteFile(folder, 'env.txt')).rejects.toThrow(/not available remotely/)
  })

  it('accepts a folder reached through a symlink', async () => {
    const alias = join(base, 'alias')
    await symlink(folder, alias)
    await expect(readRemoteFile(alias, 'out/chart.png')).resolves.toMatchObject({ name: 'chart.png' })
  })

  it('refuses dotfiles, dot-folders and key-like names', async () => {
    for (const path of ['.env', '.env.local', '.ssh/config', 'id_ed25519', 'server.pem', 'tls.KEY']) {
      const err = await resolveRemoteFile(folder, path).catch((e: unknown) => e)
      expect(err, path).toBeInstanceOf(RemoteRefused)
      expect((err as Error).message, path).toMatch(/not available remotely/)
    }
  })

  it('refuses a missing file and a folder', async () => {
    await expect(readRemoteFile(folder, 'nope.png')).rejects.toThrow(/not found/)
    await expect(readRemoteFile(folder, 'out')).rejects.toThrow(/not a file/)
  })
})
