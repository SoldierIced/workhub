// A file a device asks for, inside a session's folder: an image the agent made, a log it wrote.
import { readFile, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import type { RemoteFile } from '../../shared/remote-api'

/** Files above this are not sent to a phone. */
export const REMOTE_FILE_MAX_BYTES = 8 * 1024 * 1024

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.ts': 'text/plain',
  '.js': 'text/plain',
  '.py': 'text/plain'
}

export function mimeOf(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

/** The file as a device receives it, or an error when it is missing, a folder, or too large. */
export async function readRemoteFile(path: string): Promise<RemoteFile> {
  const info = await stat(path)
  if (!info.isFile()) throw new Error('not a file')
  if (info.size > REMOTE_FILE_MAX_BYTES) throw new Error('the file is too large to send')
  const bytes = await readFile(path)
  return { name: basename(path), size: info.size, mime: mimeOf(path), data: bytes.toString('base64') }
}
