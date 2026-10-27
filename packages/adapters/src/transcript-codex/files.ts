/**
 * Where Codex keeps its rollout files and how to read them. Rollouts are
 * `<codex home>/sessions/YYYY/MM/DD/rollout-<timestamp>-<session id>.jsonl`; newer Codex versions
 * may compress them to `.jsonl.zst`, which is read with the zstd that ships with Node 22.15+.
 */
import { createReadStream } from 'node:fs'
import { open, readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createZstdDecompress, zstdDecompress } from 'node:zlib'
import { promisify } from 'node:util'
import { isDirectory, safeId } from '../shared/reader-utils'

/**
 * `$CODEX_HOME`, else `~/.codex`. Verified from Codex's documentation only (Codex is not
 * installed on the development machine); on Windows the same folder under the user profile is
 * expected, not verified.
 */
export function defaultCodexHome(): string {
  return process.env['CODEX_HOME'] || join(homedir(), '.codex')
}

export const isCompressed = (path: string): boolean => path.endsWith('.zst')

const ROLLOUT = /^rollout-.*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(\.zst)?$/i

/** The session id in a rollout file name. */
export function rolloutId(fileName: string): string | undefined {
  return ROLLOUT.exec(fileName)?.[1]
}

async function sortedDesc(dir: string, keep: (name: string) => boolean): Promise<string[]> {
  try {
    return (await readdir(dir)).filter(keep).sort().reverse()
  } catch {
    return []
  }
}

/** Every rollout file, newest day first and newest file first inside a day. */
export async function* rolloutFiles(sessionsDir: string): AsyncGenerator<string> {
  const numeric = (n: string) => /^\d+$/.test(n)
  for (const year of await sortedDesc(sessionsDir, numeric)) {
    for (const month of await sortedDesc(join(sessionsDir, year), numeric)) {
      for (const day of await sortedDesc(join(sessionsDir, year, month), numeric)) {
        const dir = join(sessionsDir, year, month, day)
        if (!(await isDirectory(dir))) continue
        for (const name of await sortedDesc(dir, (n) => ROLLOUT.test(n))) yield join(dir, name)
      }
    }
  }
}

/** The rollout of a session: the file whose name ends with its id. */
export async function findRollout(sessionsDir: string, sessionId: string): Promise<string | null> {
  const id = safeId(sessionId)
  if (!id) return null
  for await (const path of rolloutFiles(sessionsDir)) {
    if (rolloutId(path.split(/[\\/]/).pop() ?? '')?.toLowerCase() === id.toLowerCase()) return path
  }
  return null
}

/** The whole text of a rollout, decompressed when needed. Empty when it cannot be read. */
export async function readRollout(path: string): Promise<string> {
  try {
    const data = await readFile(path)
    if (!isCompressed(path)) return data.toString('utf8')
    return (await promisify(zstdDecompress)(data)).toString('utf8')
  } catch {
    return ''
  }
}

/** The first `maxBytes` of a rollout's text, without reading or decompressing the rest. */
export async function readRolloutHead(path: string, maxBytes: number): Promise<string> {
  try {
    if (!isCompressed(path)) {
      const handle = await open(path, 'r')
      try {
        const buffer = Buffer.alloc(maxBytes)
        const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0)
        return buffer.toString('utf8', 0, bytesRead)
      } finally {
        await handle.close()
      }
    }
    const source = createReadStream(path)
    const stream = source.pipe(createZstdDecompress())
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of stream) {
      chunks.push(chunk as Buffer)
      size += (chunk as Buffer).length
      if (size >= maxBytes) break
    }
    source.destroy()
    stream.destroy()
    return Buffer.concat(chunks).toString('utf8', 0, Math.min(size, maxBytes))
  } catch {
    return ''
  }
}
