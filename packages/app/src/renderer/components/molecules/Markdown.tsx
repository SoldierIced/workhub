import { useMemo, useRef, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '../../lib/cn'
import { CopyButton } from './CopyButton'

/** Only web and mail links open (in the default browser); anything else stays plain text. */
export function safeHref(href: string | undefined): string | null {
  if (!href) return null
  try {
    const url = new URL(href)
    return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:' ? url.href : null
  } catch {
    return null
  }
}

/** The renderers of a text whose links open the way `profileId` opens links (its browser), or the default one. */
const componentsFor = (profileId: string | null | undefined): Components => ({
  a: ({ href, children }) => {
    const target = safeHref(href)
    if (!target) return <span>{children}</span>
    return (
      <a
        href={target}
        title={target}
        onClick={(e) => {
          e.preventDefault()
          window.hub.openExternal(target, profileId)
        }}
      >
        {children}
      </a>
    )
  },
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  // Images in a reply would load remote content; show their alt text and address instead.
  img: ({ alt, src }) => <span className="text-muted">{alt || (typeof src === 'string' ? src : '')}</span>
})

const COMPONENTS = componentsFor(null)

/** A fenced code block with its own copy button in the corner. */
function CodeBlock({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null)
  return (
    <div className="group/code relative max-w-full min-w-0">
      <pre ref={ref}>{children}</pre>
      <CopyButton text={() => ref.current?.innerText ?? ''} className="absolute top-1 right-1 bg-surface/80 opacity-70 group-hover/code:opacity-100" />
    </div>
  )
}

/**
 * An agent's reply as Markdown: GitHub tables, code blocks and links. Raw HTML in the text is
 * dropped (`skipHtml`), never rendered; images show as text. `profileId` opens links in that
 * profile's browser.
 */
/**
 * Keeps single line breaks as breaks (plain notes and alert details are written line by line),
 * outside fenced code blocks. Markdown alone would join those lines into one paragraph.
 */
export function hardBreaks(text: string): string {
  let fenced = false
  return text
    .split('\n')
    .map((line, i, lines) => {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced
      const next = lines[i + 1]
      const joinsNext = !fenced && line.trim() !== '' && next !== undefined && next.trim() !== '' && !/^\s*(```|~~~)/.test(next)
      return joinsNext && !line.endsWith('  ') ? `${line}  ` : line
    })
    .join('\n')
}

export function Markdown({ text, className, profileId, breaks }: { text: string; className?: string; profileId?: string | null; breaks?: boolean }) {
  const components = useMemo(() => (profileId ? componentsFor(profileId) : COMPONENTS), [profileId])
  return (
    <div className={cn('markdown min-w-0 break-words', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={components}>
        {breaks ? hardBreaks(text) : text}
      </ReactMarkdown>
    </div>
  )
}
