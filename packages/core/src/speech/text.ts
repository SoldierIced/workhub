/**
 * Turns the Markdown of a reply into plain text that reads well aloud: no code blocks, link
 * addresses, bare URLs or formatting marks, which a voice would spell out. Pure on purpose, so it
 * can be checked without speaking (port of Workhub 1's SpeechText).
 */

/** Longest text handed to the voice (about three minutes of speech). */
export const SPEECH_MAX_LENGTH = 4000

interface Fence {
  marker: string
  length: number
}

/** The speakable text of `markdown`, cut at a sentence end when longer than `limit`. Empty when nothing can be read. */
export function speechText(markdown: string, limit: number = SPEECH_MAX_LENGTH): string {
  const spoken: string[] = []
  let fence: Fence | null = null
  for (const raw of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim()
    if (fence) {
      // A code block is dropped whole, up to its closing fence (or the end of the text): a run of
      // the same mark at least as long as the opening one.
      if (line.length >= fence.length && [...line].every((c) => c === fence!.marker)) fence = null
      continue
    }
    const opened = openingFence(line)
    if (opened) {
      fence = opened
      continue
    }
    const text = speakable(line)
    if (text) spoken.push(text)
  }
  return capped(spoken.join('\n'), limit)
}

/** A backtick fence cannot carry backticks after the run, which is how an inline triple-backtick span is told apart. */
function openingFence(line: string): Fence | null {
  const marker = line[0]
  if (marker !== '`' && marker !== '~') return null
  let run = 0
  while (line[run] === marker) run++
  if (run < 3) return null
  return marker === '`' && line.slice(run).includes('`') ? null : { marker, length: run }
}

const isRule = (line: string): boolean => /^(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,}|=+)$/.test(line)
const isTableSeparator = (line: string): boolean => line.includes('|') && line.includes('-') && /^[|\-: ]+$/.test(line)
const isLinkDefinition = (line: string): boolean => /^\[[^\]]+\]:\s*\S+/.test(line)

/** One trimmed line as speech; null when it holds nothing to read. */
function speakable(line: string): string | null {
  if (!line || isRule(line) || isTableSeparator(line) || isLinkDefinition(line)) return null
  let text = line.replace(/^(?:>\s?)+/, '').trim()
  // Headings, list items and table rows are short fragments with no full stop: one is added so the voice pauses.
  let fragment = false
  if (/^#{1,6}\s+/.test(text)) {
    text = text.replace(/^#{1,6}\s+/, '')
    fragment = true
  } else if (/^(?:[-*+]|\d+[.)])\s+/.test(text)) {
    text = text.replace(/^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '')
    fragment = true
  } else if (text.startsWith('|')) {
    text = text
      .split('|')
      .map((c) => c.trim())
      .filter(Boolean)
      .join(', ')
    fragment = true
  }
  text = inline(text)
  if (!text || !/[\p{L}\p{N}]/u.test(text)) return null
  if (fragment && !'.!?:;,…'.includes(text[text.length - 1]!)) text += '.'
  return text
}

// Private-use characters around the index: nothing else in a reply uses them, and no pattern below touches them.
const placeholder = (index: number): string => `${index}`

/** `line` with every match of `pattern` swapped for a placeholder; the text of `group` goes to `kept`. */
function stash(pattern: RegExp, group: number, line: string, kept: string[]): string {
  return line.replace(pattern, (...args: unknown[]) => {
    kept.push(String(args[group]).trim())
    return placeholder(kept.length - 1)
  })
}

function inline(line: string): string {
  const kept: string[] = []
  let text = stash(/(`+)([^`]+)\1/g, 2, line, kept)
  text = stash(/\\([\\`*_{}[\]()#+\-.!|>~<])/g, 1, text, kept)
  text = text.replace(/!\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, '$1') // images: their description
  text = text.replace(/\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, '$1') // links: their text
  text = text.replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
  text = text.replace(/<(?:https?:\/\/|mailto:)[^>]*>/g, '')
  text = text.replace(/<\/?[A-Za-z][^>]*>/g, '')
  // The address goes, the sentence punctuation after it stays.
  text = text.replace(/(?:https?:\/\/|www\.)[^\s<>()[\]]*[^\s<>()[\].,;:!?'"]/g, '')
  text = text.replace(/(\*{1,3})(?=\S)([^*\n]*?\S)\1/g, '$2')
  text = text.replace(/(?<!\w)(_{1,3})(?=\S)([^_\n]*?\S)\1(?!\w)/g, '$2')
  text = text.replace(/~~([^~\n]+)~~/g, '$1')
  text = text.replace(/\(\s*\)|\[\s*\]/g, '')
  text = text.replace(/[ \t]+/g, ' ')
  text = text.replace(/\s+([,.;:!?])/g, '$1')
  kept.forEach((original, i) => {
    text = text.split(placeholder(i)).join(original)
  })
  return text.trim()
}

/** `text` up to `limit` characters, cut where a sentence ends (else at a space, else hard). */
function capped(text: string, limit: number): string {
  if (text.length <= limit) return text
  const head = text.slice(0, limit)
  let cut = -1
  let space = -1
  for (let i = head.length - 1; i >= 0; i--) {
    const c = head[i]!
    const next = text[i + 1]
    if (c === '\n' || ('.!?…'.includes(c) && (next === undefined || /\s/.test(next)))) {
      cut = i + 1
      break
    }
    if (space < 0 && /\s/.test(c)) space = i
  }
  return text.slice(0, cut >= 0 ? cut : space >= 0 ? space : head.length).trim()
}
