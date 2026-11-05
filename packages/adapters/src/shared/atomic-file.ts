import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Errors Windows gives while another process (an antivirus, an indexer) briefly holds the target. */
const TRANSIENT_RENAME = new Set(['EPERM', 'EBUSY', 'EACCES'])
const RENAME_DELAYS_MS = [10, 50, 100, 250]

/** `rename`, retried with backoff while it fails with a transient Windows error. */
export async function renameWithRetry(
  from: string,
  to: string,
  doRename: (from: string, to: string) => Promise<void> = rename,
  delaysMs: readonly number[] = RENAME_DELAYS_MS
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await doRename(from, to)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (attempt >= delaysMs.length || !code || !TRANSIENT_RENAME.has(code)) throw err
      await new Promise((r) => setTimeout(r, delaysMs[attempt]))
    }
  }
}

/** Flushes a folder's entries (the rename) to disk on POSIX. Best-effort: Windows cannot open a folder. */
async function syncDirectory(dir: string): Promise<void> {
  if (process.platform === 'win32') return
  try {
    const handle = await open(dir, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    /* some file systems refuse fsync on a folder */
  }
}

/**
 * Writes a file atomically: a temp file in the same folder, fsync, then rename over the target
 * (retried briefly on Windows' transient EPERM/EBUSY/EACCES), then fsync of the folder on POSIX.
 * A crash mid-write leaves the old file intact. `mode` applies to newly written files.
 */
export async function writeFileAtomic(path: string, data: string, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    const handle = await open(tmp, 'w', mode)
    try {
      await handle.writeFile(data, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await renameWithRetry(tmp, path)
  } catch (err) {
    await unlink(tmp).catch(() => {})
    throw err
  }
  await syncDirectory(dirname(path))
}

/** File contents, or null when the file does not exist. */
export async function readFileIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/** Runs async tasks one at a time, in call order (keeps concurrent saves from interleaving). */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve()

  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task, task)
    this.tail = next.catch(() => {})
    return next
  }
}
