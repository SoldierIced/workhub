import type { ImageInput } from '@workhub/core'

/** Image types Claude accepts in a prompt. */
export const PROMPT_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const
/** Pasted images per prompt (Workhub 1 shows a row of thumbnails; a few are plenty). */
export const MAX_PROMPT_IMAGES = 6
/** Claude's limit per image is 5 MB of base64. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024

/** A `data:` URL of an accepted image as a prompt image; null for anything else. */
export function imageInputFromDataUrl(url: string): ImageInput | null {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url)
  if (!m) return null
  const mediaType = m[1]!.toLowerCase()
  if (!(PROMPT_IMAGE_TYPES as readonly string[]).includes(mediaType)) return null
  const data = m[2]!
  if (!data || data.length > MAX_IMAGE_BYTES) return null
  return { mediaType, data }
}

/** Reads the images of a paste as data URLs. */
export function readPastedImages(items: DataTransferItemList): Promise<string[]> {
  const files = [...items]
    .filter((i) => i.kind === 'file' && (PROMPT_IMAGE_TYPES as readonly string[]).includes(i.type))
    .map((i) => i.getAsFile())
    .filter((f): f is File => f !== null)
  return Promise.all(
    files.map(
      (f) =>
        new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result))
          reader.onerror = () => reject(reader.error ?? new Error('could not read the image'))
          reader.readAsDataURL(f)
        })
    )
  )
}
