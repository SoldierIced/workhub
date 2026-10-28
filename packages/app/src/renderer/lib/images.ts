import type { ImageInput } from '@workhub/core'

/** Image types Claude accepts in a prompt. */
export const PROMPT_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const
/** Pasted images per prompt (Workhub 1 shows a row of thumbnails; a few are plenty). */
export const MAX_PROMPT_IMAGES = 6
/** Claude's limit per image is 5 MB of base64. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
/** The largest file that stays under `MAX_IMAGE_BYTES` once encoded (base64 adds a third). */
export const MAX_IMAGE_FILE_BYTES = Math.floor((MAX_IMAGE_BYTES / 4) * 3)

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

/** Why an image file cannot go with a prompt; null when it can. */
export type ImageRejection = 'type' | 'size' | 'count'

export function checkImageFile(file: Pick<File, 'type' | 'size'>): ImageRejection | null {
  if (!(PROMPT_IMAGE_TYPES as readonly string[]).includes(file.type.toLowerCase())) return 'type'
  if (file.size > MAX_IMAGE_FILE_BYTES) return 'size'
  return null
}

export interface ImageFilePick<F> {
  accepted: F[]
  rejected: { file: F; reason: ImageRejection }[]
}

/**
 * Splits pasted or dropped files into the images that can go with the prompt and the ones left
 * out (wrong type, too large, or past the per-prompt count given the `already` attached ones).
 */
export function pickImageFiles<F extends Pick<File, 'type' | 'size'>>(files: readonly F[], already: number): ImageFilePick<F> {
  const out: ImageFilePick<F> = { accepted: [], rejected: [] }
  for (const file of files) {
    const reason = checkImageFile(file) ?? (already + out.accepted.length >= MAX_PROMPT_IMAGES ? 'count' : null)
    if (reason) out.rejected.push({ file, reason })
    else out.accepted.push(file)
  }
  return out
}

/** Files of a paste or a drop that look like images (any image type: the wrong ones get a message). */
export function imageFilesOf(data: DataTransfer): File[] {
  const fromItems = [...data.items].filter((i) => i.kind === 'file' && i.type.startsWith('image/')).map((i) => i.getAsFile())
  const files = fromItems.filter((f): f is File => f !== null)
  return files.length ? files : [...data.files].filter((f) => f.type.startsWith('image/'))
}

/** Whether a paste or drag carries files that look like images. */
export function hasImageFiles(data: DataTransfer): boolean {
  return [...data.items].some((i) => i.kind === 'file' && i.type.startsWith('image/'))
}

/** Reads image files as data URLs. */
export function readImageFiles(files: readonly File[]): Promise<string[]> {
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

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The marker of image `n` in a prompt's text: `[Image 2]` (the word is the reader's language). */
export function imageMarker(label: string, n: number): string {
  return `[${label} ${n}]`
}

/**
 * Puts the markers of images `from + 1` to `from + count` into the text at the caret, so the prompt
 * can say which pasted image it talks about. A space keeps them apart from the words around them.
 * Returns the new text and where the caret goes, right after the markers.
 */
export function insertImageMarkers(text: string, caret: number, label: string, from: number, count: number): { text: string; caret: number } {
  if (count <= 0) return { text, caret }
  const at = Math.max(0, Math.min(caret, text.length))
  const before = text.slice(0, at)
  const after = text.slice(at)
  const markers = Array.from({ length: count }, (_, i) => imageMarker(label, from + i + 1)).join(' ')
  const lead = before && !/\s$/.test(before) ? ' ' : ''
  const trail = !after || !/^\s/.test(after) ? ' ' : ''
  const inserted = `${lead}${markers}${trail}`
  return { text: before + inserted + after, caret: at + inserted.length }
}

/**
 * Takes image `n`'s marker out of the text (with the space that kept it apart) and renumbers the
 * markers after it, so each still names the image it was put in for.
 */
export function removeImageMarker(text: string, label: string, n: number): string {
  const own = new RegExp(`( ?)${escapeRegExp(imageMarker(label, n))}( ?)`, 'g')
  const any = new RegExp(`\\[${escapeRegExp(label)} (\\d+)\\]`, 'g')
  return text.replace(own, (_m, lead: string, trail: string) => (lead && trail ? ' ' : '')).replace(any, (m, digits: string) => {
    const k = Number(digits)
    return k > n ? imageMarker(label, k - 1) : m
  })
}
