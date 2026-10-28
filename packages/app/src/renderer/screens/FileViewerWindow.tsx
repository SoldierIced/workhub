import { AppWindow, Copy, FileQuestion, FileWarning, Folder, FolderOpen, Maximize2, Minus, Plus, Scan } from 'lucide-react'
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import type { FileContent, FileStamp } from '@shared/local-review-api'
import { Button, IconButton, Spinner, TooltipProvider } from '../components/atoms'
import { EmptyState } from '../components/molecules'
import { I18nProvider, useI18n } from '../i18n/I18nProvider'
import { cn } from '../lib/cn'
import { fileName, formatBytes } from '../lib/localReview'
import { usePlatform } from '../lib/platform'

/** How often the viewer checks the file on disk: a stat per second is nothing. */
const POLL_MS = 1_000
/** Lines drawn before "Show all": a long file stays quick to open. */
const FIRST_LINES = 5_000

/** Polls the file and returns its latest content; an SVG the page cannot draw is read again as text. */
function useFile(path: string): { content: FileContent | null; forceText: () => void } {
  const [content, setContent] = useState<FileContent | null>(null)
  const [asText, setAsText] = useState(false)
  useEffect(() => {
    let alive = true
    let known: { stamp: FileStamp | null } | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      try {
        const r = await window.hub.files.read(path, known, asText)
        if (!alive) return
        if (r) {
          known = { stamp: r.stamp }
          setContent(r.content)
        }
      } catch {
        if (alive) setContent({ kind: 'unreadable' })
      }
      if (alive) timer = setTimeout(() => void tick(), POLL_MS)
    }
    void tick()
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [path, asText])
  return { content, forceText: () => setAsText(true) }
}

/** A blob URL for bytes, revoked when they change or the view goes away. */
function useBlobUrl(bytes: Uint8Array | null, mime: string | null): string | null {
  const url = useMemo(() => (bytes && mime ? URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime })) : null), [bytes, mime])
  useEffect(() => () => {
    if (url) URL.revokeObjectURL(url)
  }, [url])
  return url
}

function TextView({ text }: { text: string }) {
  const { t } = useI18n()
  const [all, setAll] = useState(false)
  const lines = useMemo(() => {
    const l = text.split(/\r?\n/)
    // A final newline does not start another line.
    if (l.length > 1 && l.at(-1) === '') l.pop()
    return l
  }, [text])
  const shown = all ? lines : lines.slice(0, FIRST_LINES)
  const width = String(lines.length).length
  return (
    <div className="min-h-0 flex-1 overflow-auto bg-surface" data-testid="file-text">
      <pre className="min-w-max px-0 py-2 font-mono text-sm leading-5">
        {shown.map((line, i) => (
          <div key={i} className="flex">
            {/* The number column: as wide as the longest number, inset like the header, ruled off from the text. */}
            <span className="sticky left-0 box-content shrink-0 border-r border-border bg-surface pr-3 pl-4 text-right text-subtle tabular-nums select-none" style={{ width: `${width}ch` }}>
              {i + 1}
            </span>
            <span className="pr-4 pl-3 whitespace-pre">{line === '' ? ' ' : line}</span>
          </div>
        ))}
      </pre>
      {!all && lines.length > FIRST_LINES && (
        <div className="border-t border-border px-4 py-2">
          <Button size="sm" onClick={() => setAll(true)}>
            {t('tool.showAll', { total: lines.length })}
          </Button>
        </div>
      )}
    </div>
  )
}

function ImageView({ url, zoom, onNatural }: { url: string; zoom: number | null; onNatural: (w: number, h: number) => void }) {
  return (
    <div className="flex min-h-0 flex-1 overflow-auto bg-surface-hover/40">
      <img
        src={url}
        alt=""
        onLoad={(e) => onNatural(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)}
        className={cn('m-auto', zoom === null && 'max-h-full max-w-full object-contain')}
        style={zoom === null ? undefined : { width: `calc(var(--natural-w) * ${zoom})`, maxWidth: 'none' }}
      />
    </div>
  )
}

function Viewer({ path }: { path: string }) {
  const { t, tn, locale } = useI18n()
  const { content, forceText } = useFile(path)
  const [zoom, setZoom] = useState<number | null>(null)
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)
  const media = content && (content.kind === 'image' || content.kind === 'pdf') ? content : null
  const url = useBlobUrl(media?.bytes ?? null, media?.mime ?? null)
  const exists = content !== null && content.kind !== 'missing'

  useEffect(() => {
    document.title = fileName(path)
  }, [path])

  const reveal = () => void window.hub.files.reveal(path)
  const openDefault = () => void window.hub.files.openDefault(path)
  const openButtons = (
    <div className="flex gap-2">
      <Button onClick={openDefault}>{t('files.openDefault')}</Button>
      <Button onClick={reveal}>{t('files.reveal')}</Button>
    </div>
  )

  let body: ReactNode
  if (!content) {
    body = (
      <div className="flex flex-1 items-center justify-center gap-2 text-muted">
        <Spinner className="size-4" /> {t('files.loading')}
      </div>
    )
  } else if (content.kind === 'missing') {
    body = <EmptyState icon={<FileQuestion className="size-6" aria-hidden />} title={t('files.missing')} description={<>{t('files.missingBody')}<br /><code className="font-mono text-xs select-text">{path}</code></>} />
  } else if (content.kind === 'folder') {
    body = <EmptyState icon={<Folder className="size-6" aria-hidden />} title={t('files.folder')} description={<code className="font-mono text-xs select-text">{path}</code>} action={<Button onClick={reveal}>{t('files.reveal')}</Button>} />
  } else if (content.kind === 'unreadable') {
    body = <EmptyState icon={<FileWarning className="size-6" aria-hidden />} title={content.reason === 'tooLarge' ? t('files.tooLarge') : t('files.unreadable')} description={content.reason && content.reason !== 'tooLarge' ? content.reason : undefined} action={openButtons} />
  } else if (content.kind === 'binary') {
    body = <EmptyState icon={<FileWarning className="size-6" aria-hidden />} title={t('files.binary')} description={t('files.binaryBody')} action={openButtons} />
  } else if (content.kind === 'text') {
    body = <TextView text={content.text} />
  } else if (content.kind === 'image' && url) {
    body = (
      <div className="flex min-h-0 flex-1" style={natural ? ({ '--natural-w': `${natural.w}px` } as CSSProperties) : undefined}>
        <ImageView
          url={url}
          zoom={zoom}
          onNatural={(w, h) => {
            // An SVG the page cannot size is shown as the XML text it is.
            if (w === 0 && content.mime === 'image/svg+xml') forceText()
            else setNatural({ w, h })
          }}
        />
      </div>
    )
  } else if (content.kind === 'pdf' && url) {
    body = <iframe src={url} title={t('files.pdf')} className="min-h-0 flex-1 border-0 bg-surface" />
  }

  const footer: string[] = []
  if (content?.kind === 'text') footer.push(tn('files.lines', content.lineCount), formatBytes(content.size, locale))
  if (content?.kind === 'image') {
    if (natural) footer.push(t('files.pixels', { width: natural.w, height: natural.h }))
    footer.push(formatBytes(content.size, locale))
    if (zoom !== null) footer.push(`${Math.round(zoom * 100)}%`)
  }
  if (content?.kind === 'pdf' || content?.kind === 'binary') footer.push(formatBytes(content.size, locale))

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-md font-semibold">{fileName(path)}</h1>
          {/* The folder gives way first so the file name at the end of the path always shows. */}
          <div className="flex font-mono text-xs text-subtle" title={path}>
            <span className="min-w-0 truncate">{path.slice(0, path.length - fileName(path).length)}</span>
            <span className="shrink-0">{fileName(path)}</span>
          </div>
        </div>
        {content?.kind === 'image' && (
          <>
            <IconButton label={t('files.zoomOut')} icon={<Minus className="size-4" />} onClick={() => setZoom((z) => Math.max((z ?? 1) / 1.25, 0.05))} />
            <IconButton label={t('files.zoomIn')} icon={<Plus className="size-4" />} onClick={() => setZoom((z) => Math.min((z ?? 1) * 1.25, 16))} />
            <IconButton label={t('files.fit')} icon={<Scan className="size-4" />} disabled={zoom === null} onClick={() => setZoom(null)} />
            <IconButton label={t('files.actualSize')} icon={<Maximize2 className="size-4" />} onClick={() => setZoom(1)} />
          </>
        )}
        <IconButton label={t('files.copyPath')} icon={<Copy className="size-4" />} onClick={() => window.hub.files.copyPath(path)} />
        <IconButton label={t('files.reveal')} icon={<FolderOpen className="size-4" />} disabled={!exists} onClick={reveal} />
        <IconButton label={t('files.openDefault')} icon={<AppWindow className="size-4" />} disabled={!exists} onClick={openDefault} />
      </header>
      <div className="flex min-h-0 flex-1 flex-col">{body}</div>
      {footer.length > 0 && (
        <footer className="flex shrink-0 items-center gap-3 border-t border-border px-4 py-1 text-xs text-muted tabular-nums">
          {footer.map((f) => (
            <span key={f}>{f}</span>
          ))}
          {content?.kind === 'text' && content.truncated && <span className="text-warning">{t('files.truncated')}</span>}
        </footer>
      )}
    </div>
  )
}

/** The file viewer window (`#file?path=…`): one file, read-only, following its changes on disk. */
export function FileViewerWindow({ path }: { path: string }) {
  const platform = usePlatform()
  return (
    <I18nProvider>
      <TooltipProvider>
        <div className="flex h-full flex-col bg-bg">
          <div className={cn('drag-region h-10 shrink-0', platform === 'mac' ? 'pl-20' : 'pr-36')} />
          <main className="min-h-0 flex-1">
            <Viewer path={path} />
          </main>
        </div>
      </TooltipProvider>
    </I18nProvider>
  )
}
