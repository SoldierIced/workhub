import { useRef, type ReactNode } from 'react'
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

const COMPONENTS: Components = {
  a: ({ href, children }) => {
    const target = safeHref(href)
    if (!target) return <span>{children}</span>
    return (
      <a
        href={target}
        title={target}
        onClick={(e) => {
          e.preventDefault()
          window.hub.openExternal(target)
        }}
      >
        {children}
      </a>
    )
  },
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  // Images in a reply would load remote content; show their alt text and address instead.
  img: ({ alt, src }) => <span className="text-muted">{alt || (typeof src === 'string' ? src : '')}</span>
}

/** A fenced code block with its own copy button in the corner. */
function CodeBlock({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null)
  return (
    <div className="group/code relative">
      <pre ref={ref}>{children}</pre>
      <CopyButton text={() => ref.current?.innerText ?? ''} className="absolute top-1 right-1 bg-surface/80 opacity-70 group-hover/code:opacity-100" />
    </div>
  )
}

/**
 * An agent's reply as Markdown: GitHub tables, code blocks and links. Raw HTML in the text is
 * dropped (`skipHtml`), never rendered.
 */
export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn('markdown min-w-0 break-words', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  )
}
