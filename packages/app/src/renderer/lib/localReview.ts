import { fileTouchOf, summarizeTouches, type FileTouch, type SessionFile } from '@workhub/core'
import type { ChatItem } from '../store'

/** `#review?session=…`: the local review window of a session. */
export function parseReviewHash(hash: string): { sessionId: string } | null {
  const m = /^#review\?(.*)$/.exec(hash)
  if (!m) return null
  const sessionId = new URLSearchParams(m[1]).get('session')
  return sessionId ? { sessionId } : null
}

/** `#file?path=…`: the file viewer window of one file. */
export function parseFileHash(hash: string): { path: string } | null {
  const m = /^#file\?(.*)$/.exec(hash)
  if (!m) return null
  const path = new URLSearchParams(m[1]).get('path')
  return path ? { path } : null
}

/** Every file the session's agent edited, wrote or read, once, most recent first. */
export function sessionFiles(items: readonly ChatItem[]): SessionFile[] {
  const touches: FileTouch[] = []
  for (const item of items) {
    if (item.kind !== 'tool') continue
    const touch = fileTouchOf(item.view)
    if (touch) touches.push({ ...touch, failed: item.status === 'failed' || item.result?.isError === true })
  }
  return summarizeTouches(touches)
}

/** The folder of a file, relative to the session's folder when it is inside it ("./src"), else as is. */
export function folderLabel(path: string, cwd: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const parent = cut > 0 ? path.slice(0, cut) : path
  const base = cwd.replace(/[\\/]+$/, '')
  if (parent === base) return './'
  for (const sep of ['/', '\\']) if (parent.startsWith(base + sep)) return './' + parent.slice(base.length + 1)
  return parent
}

export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

/** "12.3 KB" style sizes for the viewer's footer. */
export function formatBytes(n: number, locale: string): string {
  const units = ['B', 'KB', 'MB', 'GB']
  let v = n
  let u = 0
  while (v >= 1000 && u < units.length - 1) {
    v /= 1000
    u++
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: u === 0 ? 0 : 1 }).format(v)} ${units[u]}`
}

/** A new comment id, unique enough within a session's drafts. */
export function newCommentId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`
}
