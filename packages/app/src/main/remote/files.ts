// A file a device asks for, inside a session's folder: an image the agent made, a log it wrote.
import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { RemoteFile } from '../../shared/remote-api'
import { RemoteRefused } from './dispatcher'

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

/**
 * Names a device never gets, wherever they are in the path: dotfiles and dot-folders (`.env`,
 * `.ssh`, `.git`), private keys and certificates.
 */
const SECRET_NAME = [/^\./, /^id_/i, /\.(pem|key|p12|pfx)$/i]

function hasSecretPart(rel: string): boolean {
  return rel.split(sep).some((part) => SECRET_NAME.some((re) => re.test(part)))
}

/** `rel` (from `relative(root, target)`) names something strictly inside `root`. */
function inside(rel: string): boolean {
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/**
 * The real path of `path` (absolute, or relative to `folder`) when it is inside `folder` once every
 * symlink is resolved, and neither the path as asked nor the real one names a secret-like file.
 */
export async function resolveRemoteFile(folder: string, path: string): Promise<string> {
  if (typeof folder !== 'string' || !folder || typeof path !== 'string' || !path.trim()) throw new RemoteRefused('a path is required')
  const asked = relative(resolve(folder), resolve(folder, path))
  if (!inside(asked)) throw new RemoteRefused('the file is not in the session folder')
  if (hasSecretPart(asked)) throw new RemoteRefused('the file is not available remotely')
  let root: string
  let target: string
  try {
    root = await realpath(folder)
    target = await realpath(resolve(folder, path))
  } catch {
    throw new RemoteRefused('the file was not found')
  }
  const real = relative(root, target)
  if (!inside(real)) throw new RemoteRefused('the file is not in the session folder')
  if (hasSecretPart(real)) throw new RemoteRefused('the file is not available remotely')
  return target
}

/**
 * A file inside `folder` as a device receives it (see resolveRemoteFile), or a refusal when it is
 * outside, secret-like, missing, a folder, or too large.
 */
export async function readRemoteFile(folder: string, path: string): Promise<RemoteFile> {
  const target = await resolveRemoteFile(folder, path)
  const info = await stat(target)
  if (!info.isFile()) throw new RemoteRefused('not a file')
  if (info.size > REMOTE_FILE_MAX_BYTES) throw new RemoteRefused('the file is too large to send')
  const bytes = await readFile(target)
  return { name: basename(target), size: info.size, mime: mimeOf(target), data: bytes.toString('base64') }
}
