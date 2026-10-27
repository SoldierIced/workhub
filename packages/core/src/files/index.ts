/**
 * Which files a session's agent touched, and how the file viewer tells text from the rest
 * (Workhub 1's FileTools). Pure: the disk is read by the app.
 */
import type { ToolView } from '../domain/tool-view'

export type FileKind = 'image' | 'pdf' | 'other'

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif'])

function extensionOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/** By extension: what the viewer draws as an image, as a PDF, or reads as text. */
export function fileKindOfPath(path: string): FileKind {
  const ext = extensionOf(path)
  if (ext === 'pdf') return 'pdf'
  return IMAGE_EXTENSIONS.has(ext) ? 'image' : 'other'
}

/** The MIME type the viewer hands an image or PDF to the page with. */
export function mimeOfPath(path: string): string | null {
  const ext = extensionOf(path)
  const types: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
    ico: 'image/x-icon',
    avif: 'image/avif',
    pdf: 'application/pdf'
  }
  return types[ext] ?? null
}

/** Whether a path is absolute on POSIX or Windows. */
export function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('\\\\')
}

/**
 * `~` expanded, a relative path taken from the session folder, `.` and `..` resolved. Keeps the
 * separator style of the path it builds (Windows paths stay with backslashes).
 */
export function absoluteFilePath(raw: string, base: string, home: string): string {
  let p = raw.trim()
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = home + p.slice(1)
  if (!isAbsolutePath(p)) p = base.replace(/[\\/]+$/, '') + (base.includes('\\') && !base.includes('/') ? '\\' : '/') + p
  const windows = /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\')
  const sep = windows ? '\\' : '/'
  const prefix = windows ? (p.startsWith('\\\\') ? '\\\\' : p.slice(0, 2) + '\\') : '/'
  const rest = windows ? (p.startsWith('\\\\') ? p.slice(2) : p.slice(3)) : p.slice(1)
  const out: string[] = []
  for (const part of rest.split(/[\\/]+/)) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return prefix + out.join(sep)
}

export type FileTouchKind = 'read' | 'edited' | 'wrote'

/** One tool call that touched a file. */
export interface FileTouch {
  kind: FileTouchKind
  path: string
  failed: boolean
  at?: number
}

/** The file a tool call worked on, when it names one: an edit, a write or a read. */
export function fileTouchOf(view: ToolView | undefined): { kind: FileTouchKind; path: string } | null {
  if (!view) return null
  if (view.kind === 'edit') return { kind: 'edited', path: view.path }
  if (view.kind === 'write') return { kind: 'wrote', path: view.path }
  if (view.kind === 'read') return { kind: 'read', path: view.path }
  return null
}

export interface SessionFile {
  path: string
  /** The latest change, or `read` when the file was only read. */
  kind: FileTouchKind
  at?: number
  edited: boolean
}

/**
 * Every file once, most recent first. A failed call changed nothing, so it does not count. A file
 * that was edited stays an edited file even if the agent read it again afterwards, and keeps its place.
 */
export function summarizeTouches(touches: readonly FileTouch[]): SessionFile[] {
  const order = new Map<string, number>()
  const entries = new Map<string, SessionFile>()
  touches.forEach((touch, index) => {
    if (touch.failed || !touch.path.trim()) return
    const editing = touch.kind !== 'read'
    const entry = entries.get(touch.path) ?? { path: touch.path, kind: touch.kind, at: touch.at, edited: editing }
    if (editing) {
      entry.kind = touch.kind
      entry.at = touch.at
      entry.edited = true
    } else if (!entry.edited) {
      entry.kind = touch.kind
      entry.at = touch.at
    }
    if (editing || !entry.edited) order.set(touch.path, index)
    entries.set(touch.path, entry)
  })
  return [...entries.values()].sort((a, b) => (order.get(b.path) ?? 0) - (order.get(a.path) ?? 0))
}

/** Text longer than this is cut: laying out more would freeze the window. */
export const TEXT_VIEW_LIMIT = 2 * 1024 * 1024

/** Lines in a text; a final newline does not start another line. */
export function lineCount(text: string): number {
  if (!text) return 0
  let n = 0
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++
  return text.endsWith('\n') ? n : n + 1
}
