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

/** Appends whole lines to a parser; an unfinished last line waits for the next read. */
export class LineTail {
  private offset = 0
  private partial = ''
  constructor(readonly path: string) {}

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
      if (size < this.offset) return true
      const length = size - this.offset
      if (length > 0) {
        const buffer = Buffer.alloc(length)
        await handle.read(buffer, 0, length, this.offset)
        this.offset = size
        const lines = (this.partial + buffer.toString('utf8')).split('\n')
        this.partial = lines.pop() ?? ''
        for (const line of lines) if (line.trim()) onLine(line)
      }
      return true
    } finally {
      await handle.close()
    }
  }
}
