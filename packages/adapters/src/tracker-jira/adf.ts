/** Atlassian Document Format (Jira Cloud rich text) to plain text, and back for comments. */

interface AdfNode {
  type?: string
  text?: string
  content?: AdfNode[]
  attrs?: Record<string, unknown>
  marks?: { type?: string; attrs?: Record<string, unknown> }[]
}

const BLOCKS = new Set(['paragraph', 'heading', 'codeBlock', 'blockquote', 'panel', 'rule', 'table', 'mediaSingle', 'mediaGroup', 'expand'])

function inline(node: AdfNode): string {
  switch (node.type) {
    case 'text': {
      const text = node.text ?? ''
      const href = node.marks?.find((m) => m.type === 'link')?.attrs?.['href']
      return typeof href === 'string' && href !== text ? `${text} (${href})` : text
    }
    case 'hardBreak':
      return '\n'
    case 'mention':
      return String(node.attrs?.['text'] ?? '@user')
    case 'emoji':
      return String(node.attrs?.['text'] ?? node.attrs?.['shortName'] ?? '')
    case 'inlineCard':
    case 'blockCard':
    case 'embedCard':
      return String(node.attrs?.['url'] ?? '')
    case 'media':
    case 'mediaInline':
      return '[attachment]'
    case 'status':
      return `[${String(node.attrs?.['text'] ?? '')}]`
    default:
      return (node.content ?? []).map(inline).join('')
  }
}

function render(node: AdfNode, indent = ''): string {
  if (node.type === 'bulletList' || node.type === 'orderedList') {
    return (node.content ?? [])
      .map((item, i) => {
        const marker = node.type === 'orderedList' ? `${i + 1}. ` : '- '
        const body = (item.content ?? []).map((child) => render(child, indent + '  ')).join('\n')
        return `${indent}${marker}${body.trimStart()}`
      })
      .join('\n')
  }
  if (node.type && BLOCKS.has(node.type)) {
    if (node.type === 'table') return (node.content ?? []).map((row) => (row.content ?? []).map((cell) => (cell.content ?? []).map((c) => render(c)).join(' ')).join(' | ')).join('\n')
    if (node.type === 'rule') return '---'
    const text = (node.content ?? []).map((c) => (c.type && BLOCKS.has(c.type) ? render(c, indent) : inline(c))).join('')
    return indent + text
  }
  return indent + inline(node)
}

/** Plain text of an ADF document; a plain string (older Jira) passes through. */
export function adfToText(doc: unknown): string {
  if (typeof doc === 'string') return doc
  if (!doc || typeof doc !== 'object') return ''
  const root = doc as AdfNode
  return (root.content ?? [])
    .map((n) => render(n))
    .filter((s) => s.length > 0)
    .join('\n\n')
    .trim()
}

/** A comment body: blank lines start paragraphs, single line breaks become hard breaks. */
export function textToAdf(text: string): { type: 'doc'; version: 1; content: AdfNode[] } {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((paragraph): AdfNode => {
      const content: AdfNode[] = []
      paragraph.split('\n').forEach((line, i) => {
        if (i > 0) content.push({ type: 'hardBreak' })
        if (line) content.push({ type: 'text', text: line })
      })
      return { type: 'paragraph', content }
    })
  return { type: 'doc', version: 1, content: paragraphs }
}
