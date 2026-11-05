/**
 * Editing one field of a flow-map file in place: Settings → Alerts writes a map's `alerts` back
 * into the JSON a person or an agent wrote, and every other byte of the file (its order, its
 * spacing, fields Workhub does not know) stays as it was.
 */

interface Member {
  key: string
  /** Index of the key's opening quote. */
  keyStart: number
  valueStart: number
  /** One past the value's last character. */
  valueEnd: number
}

const isSpace = (c: string | undefined) => c === ' ' || c === '\n' || c === '\r' || c === '\t'

function skipSpace(text: string, i: number): number {
  while (i < text.length && isSpace(text[i])) i++
  return i
}

function skipString(text: string, i: number): number {
  // text[i] is the opening quote.
  i++
  while (i < text.length) {
    const c = text[i]
    if (c === '\\') i += 2
    else if (c === '"') return i + 1
    else i++
  }
  throw new Error('unterminated string')
}

function skipValue(text: string, i: number): number {
  const c = text[i]
  if (c === '"') return skipString(text, i)
  if (c === '{' || c === '[') {
    let depth = 0
    while (i < text.length) {
      const ch = text[i]
      if (ch === '"') {
        i = skipString(text, i)
        continue
      }
      if (ch === '{' || ch === '[') depth++
      else if (ch === '}' || ch === ']') {
        depth--
        if (depth === 0) return i + 1
      }
      i++
    }
    throw new Error('unterminated value')
  }
  // A number, true, false or null.
  while (i < text.length && !isSpace(text[i]) && text[i] !== ',' && text[i] !== '}' && text[i] !== ']') i++
  return i
}

/** The top-level members of a JSON object text, in order; throws when the text is not one. */
function topMembers(text: string): { members: Member[]; close: number } {
  let i = skipSpace(text, 0)
  if (text[i] !== '{') throw new Error('not a JSON object')
  i = skipSpace(text, i + 1)
  const members: Member[] = []
  if (text[i] === '}') return { members, close: i }
  for (;;) {
    if (text[i] !== '"') throw new Error('expected a key')
    const keyStart = i
    const keyEnd = skipString(text, i)
    const key = JSON.parse(text.slice(keyStart, keyEnd)) as string
    i = skipSpace(text, keyEnd)
    if (text[i] !== ':') throw new Error('expected ":"')
    const valueStart = skipSpace(text, i + 1)
    const valueEnd = skipValue(text, valueStart)
    members.push({ key, keyStart, valueStart, valueEnd })
    i = skipSpace(text, valueEnd)
    if (text[i] === ',') {
      i = skipSpace(text, i + 1)
      continue
    }
    if (text[i] === '}') return { members, close: i }
    throw new Error('expected "," or "}"')
  }
}

/** The spaces before a top-level key on its own line; empty for a one-line file. */
function indentOf(text: string, at: number): string | null {
  const line = text.lastIndexOf('\n', at - 1)
  if (line < 0) return null
  const lead = text.slice(line + 1, at)
  return /^[ \t]*$/.test(lead) ? lead : null
}

function render(value: unknown, indent: string | null): string {
  if (indent === null || indent === '') return JSON.stringify(value)
  return JSON.stringify(value, null, indent).replace(/\n/g, `\n${indent}`)
}

/**
 * The file's text with one top-level field set to `value` (or removed, for `undefined`). The
 * value is written in the file's own indentation; nothing else changes. Throws when the text is
 * not a JSON object.
 */
export function setJsonField(text: string, field: string, value: unknown): string {
  const { members, close } = topMembers(text)
  const at = members.findIndex((m) => m.key === field)
  const own = members[at]
  if (value === undefined) {
    if (!own) return text
    const next = members[at + 1]
    if (next) return text.slice(0, own.keyStart) + text.slice(next.keyStart)
    const previous = members[at - 1]
    // The last member: drop it with the comma before it, keep what preceded the closing brace.
    if (previous) return text.slice(0, previous.valueEnd) + text.slice(own.valueEnd)
    return text.slice(0, own.keyStart) + text.slice(own.valueEnd)
  }
  if (own) return text.slice(0, own.valueStart) + render(value, indentOf(text, own.keyStart)) + text.slice(own.valueEnd)
  const last = members.at(-1)
  if (!last) return text.slice(0, close) + `${JSON.stringify(field)}: ${render(value, null)}` + text.slice(close)
  const indent = indentOf(text, last.keyStart)
  const gap = indent === null ? ' ' : `\n${indent}`
  return text.slice(0, last.valueEnd) + `,${gap}${JSON.stringify(field)}: ${render(value, indent)}` + text.slice(last.valueEnd)
}
