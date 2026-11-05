/**
 * Small helpers the Kiro, OpenCode and Codex transcript readers share: defensive accessors for
 * untyped JSON, an incremental line reader and file checks. Everything fails soft.
 */
import { open, stat } from 'node:fs/promises'
import { basename } from 'node:path'

export type Obj = Record<string, unknown>

export const obj = (v: unknown): Obj | undefined => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined)
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
export const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined)
export const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/** One JSON line as an object; undefined for blank, broken or non-object lines. */
export function parseLine(line: string): Obj | undefined {
  try {
    return obj(JSON.parse(line))
  } catch {
    return undefined
  }
}

/** ISO date or epoch (seconds or milliseconds) to epoch milliseconds. */
export function toMillis(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e11 ? v * 1000 : v
  if (typeof v === 'string') {
    const t = Date.parse(v)
    return Number.isNaN(t) ? undefined : t
  }
  return undefined
}

export async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

export const fileBase = (path: string): string => basename(path.replaceAll('\\', '/'))

/** A session id becomes part of a path: only characters agents use in their ids. */
export function safeId(id: string): string | null {
  return /^[A-Za-z0-9_-]+$/.test(id) ? id : null
}

/** Shortens text to one line of at most `max` characters. */
export function oneLine(text: string, max = 100): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** How much of a file one `read` call loads at a time. */
const TAIL_CHUNK_BYTES = 4 * 1024 * 1024
const EMPTY = Buffer.alloc(0)

/**
 * Appends whole lines to a parser; an unfinished last line waits for the next read. Lines are cut
 * on the byte 0x0A before decoding, so a UTF-8 character split across two reads (or two chunks)
 * decodes whole, and a large file is read in chunks rather than in one buffer.
 */
export class LineTail {
  private offset = 0
  private partial: Buffer = EMPTY
  constructor(
    readonly path: string,
    private readonly chunkBytes = TAIL_CHUNK_BYTES
  ) {}

  /** False when the file cannot be opened. A file that shrank is skipped until it grows past the old size. */
  async read(onLine: (line: string) => void): Promise<boolean> {
    let handle
    try {
      handle = await open(this.path, 'r')
    } catch {
      return false
    }
    try {
      const { size } = await handle.stat()
      if (size <= this.offset) return true
      const buffer = Buffer.allocUnsafe(Math.min(this.chunkBytes, size - this.offset))
      while (this.offset < size) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - this.offset), this.offset)
        if (bytesRead === 0) break
        this.offset += bytesRead
        this.take(buffer.subarray(0, bytesRead), onLine)
      }
      return true
    } finally {
      await handle.close()
    }
  }

  private take(chunk: Buffer, onLine: (line: string) => void): void {
    let start = 0
    for (let nl = chunk.indexOf(0x0a, start); nl !== -1; nl = chunk.indexOf(0x0a, start)) {
      const piece = chunk.subarray(start, nl)
      const line = (this.partial.length ? Buffer.concat([this.partial, piece]) : piece).toString('utf8')
      this.partial = EMPTY
      start = nl + 1
      if (line.trim()) onLine(line)
    }
    // A copy: the read buffer is reused for the next chunk.
    if (start < chunk.length) this.partial = Buffer.concat([this.partial, chunk.subarray(start)])
  }
}
