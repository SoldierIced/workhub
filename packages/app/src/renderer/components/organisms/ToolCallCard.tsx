import {
  Bot,
  Brain,
  Check,
  ChevronRight,
  CircleAlert,
  ExternalLink,
  FilePlus,
  FileText,
  FolderOpen,
  Globe,
  ListChecks,
  Pencil,
  Plug,
  Search,
  SquareTerminal,
  Wrench,
  type LucideIcon
} from 'lucide-react'
import { memo, useEffect, useMemo, useState, type ReactNode } from 'react'
import { diffHunks, diffLines, diffStats, editHunks, relativePath, type ToolArg, type ToolResultView, type ToolView } from '@workhub/core'
import { Badge, Button, Spinner } from '../atoms'
import { CodeDiff, Markdown, safeHref } from '../molecules'
import { useI18n } from '../../i18n/I18nProvider'
import { cn } from '../../lib/cn'

/** Lines of output shown before "Show more". */
const OUTPUT_PREVIEW_LINES = 14
const OUTPUT_PREVIEW_CHARS = 2_000
/** Edits up to this many changed lines open by themselves. */
const AUTO_OPEN_CHANGES = 40

const KIND_ICON: Record<string, LucideIcon> = { read: FileText, edit: Pencil, execute: SquareTerminal, search: Search, fetch: Globe, think: Brain }

export interface ToolCallCardProps {
  title: string
  detail?: string
  /** pending, in_progress, completed, failed. */
  status: string
  /** ACP-style kind, for the icon of a call without a view. */
  toolKind?: string
  view?: ToolView
  result?: ToolResultView
  /** The session folder: paths inside it show relative. */
  cwd?: string
  /** Shows a file in the file manager (only offered when set). */
  onReveal?: (path: string) => void
  /** Opens the sub-agent a Task call started (only offered when it is known). */
  onOpenAgent?: () => void
}

/** Text output, cut to a preview with "Show more"; errors in the danger tone. Plain text only. */
export function OutputBlock({ text, truncated, isError }: { text?: string; truncated?: boolean; isError?: boolean }) {
  const { t } = useI18n()
  const [all, setAll] = useState(false)
  if (!text) return <p className="text-xs text-subtle italic">{t('tool.noOutput')}</p>
  const lines = text.split('\n')
  const long = lines.length > OUTPUT_PREVIEW_LINES || text.length > OUTPUT_PREVIEW_CHARS
  const shown = all || !long ? text : lines.slice(0, OUTPUT_PREVIEW_LINES).join('\n').slice(0, OUTPUT_PREVIEW_CHARS)
  return (
    <div className={cn('rounded-md border bg-surface', isError ? 'border-danger/40' : 'border-border')}>
      <pre className={cn('max-h-[28rem] overflow-auto px-3 py-2 font-mono text-xs leading-5 whitespace-pre-wrap break-all', isError ? 'text-danger' : 'text-muted')}>{shown}</pre>
      {(long || truncated) && (
        <div className="flex items-center gap-2 border-t border-border px-2 py-1 text-xs text-subtle">
          {long && (
            <Button size="sm" variant="ghost" onClick={() => setAll((v) => !v)}>
              {all ? t('tool.showLess') : t('tool.showMore')}
            </Button>
          )}
          {truncated && (all || !long) && <span>{t('tool.truncated')}</span>}
        </div>
      )}
    </div>
  )
}

function StatusMark({ status }: { status: string }) {
  const { t } = useI18n()
  if (status === 'failed') return <CircleAlert className="size-3.5 shrink-0 text-danger" aria-label={t('tool.failed')} />
  if (status === 'completed') return <Check className="size-3.5 shrink-0 text-success" aria-label={t('tool.done')} />
  if (status === 'pending' || status === 'in_progress') return <Spinner className="size-3 shrink-0 text-info" label={t('tool.running')} />
  return null
}

function Path({ path, cwd }: { path: string; cwd?: string }) {
  return (
    <code className="min-w-0 truncate font-mono text-xs text-text" title={path}>
      {relativePath(path, cwd)}
    </code>
  )
}

function IconAction({ label, icon: Icon, onClick }: { label: string; icon: LucideIcon; onClick: () => void }) {
  return (
    <button type="button" className="shrink-0 rounded-sm p-1 text-subtle hover:bg-surface-hover hover:text-text" aria-label={label} title={label} onClick={onClick}>
      <Icon className="size-3.5" aria-hidden />
    </button>
  )
}

function revealAction(path: string, cwd: string | undefined, onReveal: ((path: string) => void) | undefined, label: (p: string) => string) {
  return onReveal && path ? <IconAction label={label(relativePath(path, cwd))} icon={FolderOpen} onClick={() => onReveal(path)} /> : undefined
}

function Counts({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="shrink-0 font-mono text-xs tabular-nums">
      <span className="text-success">+{added}</span> <span className="text-danger">−{removed}</span>
    </span>
  )
}

function Args({ args }: { args: ToolArg[] }) {
  if (!args.length) return null
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-xs">
      {args.map((a) => (
        <div key={a.key} className="contents">
          <dt className="text-subtle">{a.key}</dt>
          <dd className="min-w-0 break-all text-muted">{a.value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** A card: a header line that toggles a body rendered only while open, so long chats stay light. */
function Frame({
  icon: Icon,
  head,
  meta,
  status,
  failed,
  body,
  always,
  actions,
  defaultOpen
}: {
  icon: LucideIcon
  head: ReactNode
  meta?: ReactNode
  /** Buttons beside the header (reveal a file, open a sub-agent), outside the toggle. */
  actions?: ReactNode
  status: string
  failed: boolean
  /** Collapsible content; none makes the header static. */
  body?: () => ReactNode
  /** Content always visible under the header (a command, a checklist). */
  always?: ReactNode
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen ?? false)
  // A call that fails after it showed (a command still running) opens to show why.
  useEffect(() => {
    if (failed) setOpen(true)
  }, [failed])
  const header = (
    <>
      {body ? <ChevronRight className={cn('size-3.5 shrink-0 text-subtle transition-transform', open && 'rotate-90')} aria-hidden /> : <span className="w-3.5 shrink-0" />}
      <Icon className={cn('size-3.5 shrink-0', failed ? 'text-danger' : 'text-muted')} aria-hidden />
      <span className="flex min-w-0 flex-1 items-center gap-2 text-sm">{head}</span>
      {meta}
      <StatusMark status={status} />
    </>
  )
  return (
    <div className={cn('ml-8 rounded-md border bg-surface text-sm [content-visibility:auto]', failed ? 'border-danger/40' : 'border-border')} data-testid="tool-card">
      <div className="flex items-center gap-1 pr-2">
        {body ? (
          <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 pl-3 text-left hover:bg-surface-hover">
            {header}
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-3">{header}</div>
        )}
        {actions}
      </div>
      {always && <div className="px-3 pb-2">{always}</div>}
      {body && open && <div className="flex flex-col gap-2 border-t border-border px-3 py-2">{body()}</div>}
    </div>
  )
}

/** One tool call in the chat, rendered for what it is: a diff, a command and its output, a search... */
export const ToolCallCard = memo(function ToolCallCard({ title, detail, status, toolKind, view, result, cwd, onReveal, onOpenAgent }: ToolCallCardProps) {
  const { t, tn } = useI18n()
  const failed = status === 'failed' || result?.isError === true
  const revealLabel = (path: string) => t('tool.reveal', { path })
  const output = () => <OutputBlock text={result?.text} truncated={result?.truncated} isError={failed} />
  const hunks = useMemo(() => {
    if (view?.kind === 'edit') return editHunks(view, result?.patch)
    if (view?.kind === 'write') return diffHunks(diffLines('', view.content))
    return []
  }, [view, result?.patch])

  if (!view) {
    const Icon = KIND_ICON[toolKind ?? ''] ?? Wrench
    return (
      <Frame
        icon={Icon}
        status={status}
        failed={failed}
        head={
          <span className="min-w-0 flex-1" title={detail}>
            <span className="block truncate">{title}</span>
            {detail && detail !== title && <span className="block truncate font-mono text-2xs text-subtle">{detail}</span>}
          </span>
        }
        body={result?.text ? output : undefined}
        defaultOpen={failed}
      />
    )
  }

  switch (view.kind) {
    case 'edit':
    case 'write': {
      const stats = diffStats(hunks)
      const isWrite = view.kind === 'write'
      return (
        <Frame
          icon={isWrite ? FilePlus : Pencil}
          status={status}
          failed={failed}
          head={
            <>
              <Path path={view.path} cwd={cwd} />
              {view.kind === 'edit' && view.edits.some((e) => e.replaceAll) && <Badge>{t('tool.replaceAll')}</Badge>}
            </>
          }
          meta={<Counts added={stats.added} removed={stats.removed} />}
          actions={revealAction(view.path, cwd, onReveal, revealLabel)}
          defaultOpen={stats.added + stats.removed <= AUTO_OPEN_CHANGES || failed}
          body={() => (
            <>
              <CodeDiff hunks={hunks} numbered={!!result?.patch?.length} label={t('tool.diffLabel', { path: relativePath(view.path, cwd) })} />
              {failed && output()}
            </>
          )}
        />
      )
    }
    case 'read': {
      const from = view.offset
      const range =
        from !== undefined && view.limit !== undefined ? t('tool.lineRange', { from, to: from + view.limit - 1 }) : from !== undefined ? t('tool.fromLine', { from }) : undefined
      return (
        <Frame
          icon={FileText}
          status={status}
          failed={failed}
          head={
            <>
              <Path path={view.path} cwd={cwd} />
              {range && <span className="shrink-0 text-xs text-subtle">{range}</span>}
            </>
          }
          actions={revealAction(view.path, cwd, onReveal, revealLabel)}
          meta={result?.lineCount !== undefined ? <span className="shrink-0 text-xs text-subtle">{tn('tool.linesRead', result.lineCount)}</span> : undefined}
          body={result ? output : undefined}
          defaultOpen={failed}
        />
      )
    }
    case 'search':
      return (
        <Frame
          icon={Search}
          status={status}
          failed={failed}
          head={
            <>
              <span className="shrink-0 text-xs text-subtle">{view.tool}</span>
              <code className="truncate font-mono text-xs text-text">{view.pattern}</code>
              {view.path && <span className="truncate text-xs text-subtle">{t('tool.in', { path: relativePath(view.path, cwd) })}</span>}
              {view.glob && <code className="shrink-0 font-mono text-2xs text-subtle">{view.glob}</code>}
            </>
          }
          meta={result?.matchCount !== undefined ? <span className="shrink-0 text-xs text-subtle">{tn('tool.results', result.matchCount)}</span> : undefined}
          body={result ? output : undefined}
          defaultOpen={failed}
        />
      )
    case 'command': {
      const exit = result?.exitCode
      return (
        <Frame
          icon={SquareTerminal}
          status={status}
          failed={failed}
          head={<span className="truncate">{view.description ?? title}</span>}
          meta={exit !== undefined ? <Badge tone={exit === 0 ? 'neutral' : 'danger'}>{t('tool.exit', { code: exit })}</Badge> : undefined}
          always={<pre className="max-h-32 overflow-auto rounded-sm bg-bg px-2 py-1 font-mono text-xs whitespace-pre-wrap break-all text-text">{`$ ${view.command}`}</pre>}
          body={result ? output : undefined}
          defaultOpen={failed}
        />
      )
    }
    case 'fetch': {
      const href = safeHref(view.url)
      return (
        <Frame
          icon={Globe}
          status={status}
          failed={failed}
          head={<span className="truncate font-mono text-xs text-text">{view.url}</span>}
          actions={href ? <IconAction label={t('tool.openLink')} icon={ExternalLink} onClick={() => window.hub.openExternal(href)} /> : undefined}
          always={view.prompt ? <p className="text-xs text-subtle">{view.prompt}</p> : undefined}
          body={result ? output : undefined}
          defaultOpen={failed}
        />
      )
    }
    case 'webSearch':
      return <Frame icon={Globe} status={status} failed={failed} head={<span className="truncate">“{view.query}”</span>} body={result ? output : undefined} defaultOpen={failed} />
    case 'task':
      return (
        <Frame
          icon={Bot}
          status={status}
          failed={failed}
          head={
            <>
              {view.subagentType && <Badge tone="accent">{view.subagentType}</Badge>}
              <span className="truncate">{view.description ?? title}</span>
            </>
          }
          actions={
            onOpenAgent ? (
              <Button size="sm" variant="ghost" onClick={onOpenAgent}>
                {t('tool.openSubagent')}
              </Button>
            ) : undefined
          }
          body={
            view.prompt || result?.text
              ? () => (
                  <>
                    {view.prompt && (
                      <div>
                        <div className="mb-1 text-xs text-subtle">{t('tool.subagentPrompt')}</div>
                        <Markdown text={view.prompt} className="text-sm text-muted" />
                      </div>
                    )}
                    {result?.text && output()}
                  </>
                )
              : undefined
          }
          defaultOpen={failed}
        />
      )
    case 'todo':
      return (
        <Frame
          icon={ListChecks}
          status={status}
          failed={failed}
          head={<span className="truncate">{title}</span>}
          always={
            <ul className="flex flex-col gap-0.5">
              {view.items.map((item, i) => (
                <li key={i} className="flex items-start gap-2 text-sm">
                  <span
                    className={cn(
                      'mt-1 inline-flex size-3 shrink-0 items-center justify-center rounded-sm border',
                      item.status === 'completed' ? 'border-success bg-success text-accent-fg' : item.status === 'in_progress' ? 'border-info' : 'border-border-strong'
                    )}
                    aria-hidden
                  >
                    {item.status === 'completed' && <Check className="size-2.5" />}
                  </span>
                  <span className={cn(item.status === 'completed' && 'text-subtle line-through', item.status === 'in_progress' && 'font-medium text-text')}>{item.text}</span>
                </li>
              ))}
            </ul>
          }
        />
      )
    case 'mcp':
      return (
        <Frame
          icon={Plug}
          status={status}
          failed={failed}
          head={
            <span className="truncate">
              <span className="text-subtle">{view.server}</span> · <span className="font-mono text-xs">{view.tool}</span>
            </span>
          }
          always={view.args.length ? <Args args={view.args} /> : undefined}
          body={result ? output : undefined}
          defaultOpen={failed}
        />
      )
    case 'generic':
      return (
        <Frame
          icon={KIND_ICON[toolKind ?? ''] ?? Wrench}
          status={status}
          failed={failed}
          head={<span className="truncate">{title}</span>}
          always={view.args.length ? <Args args={view.args} /> : undefined}
          body={result ? output : undefined}
          defaultOpen={failed}
        />
      )
  }
})
