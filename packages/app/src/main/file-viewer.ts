/**
 * The file viewer (Workhub 1's FileViewer): one window per file the agent touched, showing text,
 * images and PDFs read-only and following the file as it changes. A window reads only its own
 * file: the path it was opened for is remembered per window, and every read, reveal or open from
 * the renderer must name that path.
 */
import { open, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { BrowserWindow, IpcMainInvokeEvent, IpcMainEvent } from 'electron'
import { absoluteFilePath, fileKindOfPath, lineCount, mimeOfPath, TEXT_VIEW_LIMIT } from '@workhub/core'
import type { FileContent, FileRead, FileStamp } from '../shared/local-review-api'
import type { IpcRegistrar } from './ipc-guard'
import { cachePastedImages } from './pasted-images'

/** Images and PDFs larger than this are not drawn. */
export const MEDIA_LIMIT = 64 * 1024 * 1024

type TextResult = { kind: 'binary' } | { kind: 'text'; text: string; truncated: boolean; lineCount: number }

/**
 * Text or binary from the file's first bytes: a NUL byte in the first 8 KB means binary. UTF-8 is
 * decoded strictly first; a cut that split a multi-byte character drops up to 3 bytes; anything
 * else (Latin-1, say) is shown with replacement characters.
 */
export function textPayload(bytes: Uint8Array, truncated: boolean): TextResult {
  if (bytes.subarray(0, 8192).includes(0)) return { kind: 'binary' }
  const strict = new TextDecoder('utf-8', { fatal: true })
  const decode = (b: Uint8Array): string | null => {
    try {
      return strict.decode(b)
    } catch {
      return null
    }
  }
  let text = decode(bytes)
  for (let drop = 1; text === null && truncated && drop <= 3; drop++) text = decode(bytes.subarray(0, bytes.length - drop))
  const out = text ?? new TextDecoder('utf-8').decode(bytes)
  return { kind: 'text', text: out, truncated, lineCount: lineCount(out) }
}

async function readHead(path: string, limit: number): Promise<{ bytes: Buffer; truncated: boolean }> {
  const handle = await open(path, 'r')
  try {
    // One byte more than the limit tells a file of exactly that size from a longer one.
    const buffer = Buffer.alloc(limit + 1)
    const { bytesRead } = await handle.read(buffer, 0, limit + 1, 0)
    return { bytes: buffer.subarray(0, Math.min(bytesRead, limit)), truncated: bytesRead > limit }
  } finally {
    await handle.close()
  }
}

export function sameStamp(a: FileStamp | null | undefined, b: FileStamp | null): boolean {
  if (!a || !b) return !a && !b
  return a.size === b.size && a.mtimeMs === b.mtimeMs
}

/** Reads `path` for the viewer; `known` skips the read when the file did not change since that stamp. Null: nothing new. */
export async function readForViewer(path: string, known?: { stamp: FileStamp | null } | null, forceText = false): Promise<FileRead | null> {
  const info = await stat(path).catch(() => null)
  const stamp = info ? { size: info.size, mtimeMs: info.mtimeMs } : null
  if (known && sameStamp(known.stamp, stamp)) return null
  if (!info) return { stamp, content: { kind: 'missing' } }
  if (info.isDirectory()) return { stamp, content: { kind: 'folder' } }
  if (!info.isFile()) return { stamp, content: { kind: 'unreadable' } }
  return { stamp, content: await loadContent(path, info.size, forceText) }
}

async function loadContent(path: string, size: number, forceText: boolean): Promise<FileContent> {
  try {
    const kind = fileKindOfPath(path)
    const mime = mimeOfPath(path)
    if (!forceText && kind !== 'other' && mime) {
      if (size > MEDIA_LIMIT) return { kind: 'unreadable', reason: 'tooLarge' }
      const { bytes } = await readHead(path, MEDIA_LIMIT)
      return { kind, mime, bytes: new Uint8Array(bytes), size }
    }
    const { bytes, truncated } = await readHead(path, TEXT_VIEW_LIMIT)
    const text = textPayload(bytes, truncated)
    return text.kind === 'binary' ? { kind: 'binary', size } : { ...text, size }
  } catch (err) {
    return { kind: 'unreadable', reason: err instanceof Error ? err.message : String(err) }
  }
}

export interface FileViewerDeps {
  createWindow(hash: string, title: string): BrowserWindow
  home: string
  showItemInFolder(path: string): void
  openPath(path: string): Promise<string>
  writeClipboard(text: string): void
  /** Where pasted chat images are written to be opened here (see pasted-images.ts). */
  pastedImagesDir?: string
}

/** Opens viewer windows and answers them; returns `open` for the main process's own use. */
export function registerFileViewerIpc(ipc: IpcRegistrar, deps: FileViewerDeps): { open: (path: string, cwd?: string) => void } {
  const byPath = new Map<string, BrowserWindow>()
  const pathOf = new Map<number, string>()

  const open = (raw: string, cwd?: string): void => {
    if (typeof raw !== 'string' || !raw.trim()) return
    const path = absoluteFilePath(raw, typeof cwd === 'string' && cwd ? cwd : deps.home, deps.home)
    const existing = byPath.get(path)
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore()
      existing.focus()
      return
    }
    const name = path.split(/[\\/]/).pop() || path
    const win = deps.createWindow(`#file?path=${encodeURIComponent(path)}`, name)
    const id = win.webContents.id
    byPath.set(path, win)
    pathOf.set(id, path)
    win.on('closed', () => {
      byPath.delete(path)
      pathOf.delete(id)
    })
  }

  /** The window's own file when the renderer names it; null for anything else. */
  const own = (e: IpcMainInvokeEvent | IpcMainEvent, path: unknown): string | null => (typeof path === 'string' && pathOf.get(e.sender.id) === path ? path : null)

  ipc.handle('files:openWindow', (_e, path: string, cwd?: string) => open(path, cwd))
  // Pasted chat images get a file of their own (named after their content) that the viewer opens.
  ipc.handle('files:cacheImages', (_e, dataUrls: unknown) => (deps.pastedImagesDir ? cachePastedImages(deps.pastedImagesDir, dataUrls) : []))
  ipc.handle('files:read', (e, path: unknown, known?: { stamp: FileStamp | null } | null, forceText?: boolean) => {
    const p = own(e, path)
    if (!p) throw new Error('this window does not show that file')
    const stamp = known && typeof known === 'object' ? known.stamp : undefined
    return readForViewer(p, stamp === undefined ? null : { stamp: stamp && typeof stamp === 'object' ? { size: Number(stamp.size), mtimeMs: Number(stamp.mtimeMs) } : null }, forceText === true)
  })
  ipc.on('files:copyPath', (e, path: unknown) => {
    const p = own(e, path)
    if (p) deps.writeClipboard(p)
  })
  ipc.handle('files:reveal', async (e, path: unknown) => {
    const p = own(e, path)
    if (!p) return
    // A deleted file cannot be selected, so its folder is opened instead.
    if (await stat(p).then(() => true, () => false)) deps.showItemInFolder(p)
    else await deps.openPath(dirname(p))
  })
  ipc.handle('files:openDefault', async (e, path: unknown) => {
    const p = own(e, path)
    if (p) await deps.openPath(p)
  })
  return { open }
}
