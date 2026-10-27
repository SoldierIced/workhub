import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

export interface LocatedTranscript {
  path: string
  /** The folder the session worked in, from the first transcript lines that carry one. */
  cwd: string | null
  /** Epoch milliseconds of the last write. */
  modifiedAt: number
  configDir: string
}

const SAFE_ID = /^[A-Za-z0-9-]+$/

/** The `cwd` of the first lines (up to 256 KB) of a transcript that carry one. */
export async function transcriptCwd(path: string): Promise<string | null> {
  const handle = await open(path, 'r').catch(() => null)
  if (!handle) return null
  try {
    const buffer = Buffer.alloc(256 * 1024)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    for (const line of buffer.subarray(0, bytesRead).toString('utf8').split('\n')) {
      try {
        const cwd = (JSON.parse(line) as { cwd?: unknown }).cwd
        if (typeof cwd === 'string' && cwd) return cwd
      } catch {
        // A partial last line, or not JSON.
      }
    }
    return null
  } finally {
    await handle.close()
  }
}

/**
 * Finds a Claude session's transcript (`<config>/projects/<folder>/<id>.jsonl`) in the given
 * account folders. A session copied to another account has a transcript in each: the one written
 * last is where it went on.
 */
export async function locateClaudeTranscript(sessionId: string, configDirs: readonly string[]): Promise<LocatedTranscript | null> {
  if (!SAFE_ID.test(sessionId)) return null
  let best: LocatedTranscript | null = null
  for (const configDir of configDirs) {
    const projects = join(configDir, 'projects')
    const folders = await readdir(projects).catch(() => [] as string[])
    for (const folder of folders) {
      const path = join(projects, folder, `${sessionId}.jsonl`)
      const info = await stat(path).catch(() => null)
      if (!info?.isFile()) continue
      if (best && info.mtimeMs <= best.modifiedAt + 2000) continue
      best = { path, cwd: null, modifiedAt: info.mtimeMs, configDir }
    }
  }
  if (best) best.cwd = await transcriptCwd(best.path)
  return best
}
