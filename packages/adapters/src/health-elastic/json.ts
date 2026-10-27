/** Small readers for Elasticsearch responses, which are untyped JSON: a missing or mistyped value reads as absent, never throws. */
export type Json = unknown

export function at(value: Json, ...path: (string | number)[]): Json {
  let cur: Json = value
  for (const key of path) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string | number, Json>)[key]
  }
  return cur
}

export const num = (v: Json): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
export const str = (v: Json): string | undefined => (typeof v === 'string' ? v : undefined)
export const list = (v: Json): Json[] => (Array.isArray(v) ? v : [])

/** A `fields` value of a hit: Elasticsearch returns every field as an array. */
export function field(hit: Json, name: string): Json {
  const v = at(hit, 'fields', name)
  return Array.isArray(v) ? v[0] : v
}

/** One line: whitespace runs become one space, cut at `limit` characters with an ellipsis. */
export function clip(text: string | undefined, limit: number): string | undefined {
  if (text === undefined) return undefined
  const line = text.split(/\s+/).filter(Boolean).join(' ')
  if (!line) return undefined
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line
}
