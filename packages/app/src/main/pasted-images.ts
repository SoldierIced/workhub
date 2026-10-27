/**
 * Images pasted into the chat (Workhub 1's PastedImages): each one is written once to a file of its
 * own in the data folder, named after its content, so a thumbnail can open it in the file viewer.
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** The image types a prompt can carry, with the extension of their file. */
export const PASTED_IMAGE_EXTENSIONS: Readonly<Record<string, string>> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }

/** Base64 characters of one image at most (a prompt image is up to 5 MB of base64; history may hold a little more). */
export const MAX_PASTED_IMAGE_BASE64 = 8 * 1024 * 1024

/** Images written in one call at most. */
export const MAX_PASTED_IMAGES_PER_CALL = 32

/** The image of a `data:` URL; null for anything that is not an accepted image. */
export function decodeImageDataUrl(url: unknown): { mediaType: string; bytes: Buffer } | null {
  if (typeof url !== 'string' || url.length > MAX_PASTED_IMAGE_BASE64 + 64) return null
  const m = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(url)
  if (!m) return null
  const mediaType = m[1]!.toLowerCase()
  if (!PASTED_IMAGE_EXTENSIONS[mediaType]) return null
  const bytes = Buffer.from(m[2]!, 'base64')
  return bytes.length ? { mediaType, bytes } : null
}

/** `<first 24 hex characters of the SHA-256>.<extension>`: the same image always gets the same name. */
export function pastedImageName(bytes: Uint8Array, mediaType: string): string {
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 24)
  return `${hash}.${PASTED_IMAGE_EXTENSIONS[mediaType] ?? 'png'}`
}

/**
 * The file of a pasted image (a `data:` URL) in `dir`, written on first use (temp file, then
 * rename, so a viewer never reads half an image). Null when the URL is not an accepted image or
 * the file could not be written.
 */
export async function cachePastedImage(dir: string, dataUrl: unknown): Promise<string | null> {
  const image = decodeImageDataUrl(dataUrl)
  if (!image) return null
  const file = join(dir, pastedImageName(image.bytes, image.mediaType))
  const existing = await stat(file).catch(() => null)
  if (existing?.isFile() && existing.size === image.bytes.length) return file
  try {
    await mkdir(dir, { recursive: true })
    const tmp = `${file}.${randomUUID()}.tmp`
    await writeFile(tmp, image.bytes, { mode: 0o600 })
    await rename(tmp, file)
    return file
  } catch {
    return null
  }
}

/** Several images at once; each entry is its file, or null when that one could not be written. */
export async function cachePastedImages(dir: string, dataUrls: unknown): Promise<(string | null)[]> {
  if (!Array.isArray(dataUrls)) return []
  return Promise.all(dataUrls.slice(0, MAX_PASTED_IMAGES_PER_CALL).map((url) => cachePastedImage(dir, url)))
}
