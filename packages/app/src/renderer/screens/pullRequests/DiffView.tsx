import { useMemo, useState } from 'react'
import { FileDiff } from 'lucide-react'
import type { CommentThread, DiffFile, DiffLine } from '@workhub/core'
import { Badge, Button, Textarea } from '../../components/atoms'
import { EmptyState } from '../../components/molecules'
import { useI18n } from '../../i18n/I18nProvider'
import { cn } from '../../lib/cn'
import { diffLineCount, MAX_DIFF_LINES, relativeTime } from '../../lib/pullRequests'

const ROW: Record<DiffLine['kind'], string> = {
  added: 'bg-success-soft',
  removed: 'bg-danger-soft',
  context: ''
}
const SIGN: Record<DiffLine['kind'], string> = { added: '+', removed: '−', context: ' ' }
const SIGN_COLOR: Record<DiffLine['kind'], string> = { added: 'text-success', removed: 'text-danger', context: 'text-subtle' }

export interface DiffViewProps {
  files: DiffFile[]
  threads: CommentThread[]
  canReply: boolean
  /** Returns an error text, or null when the reply was sent. */
  onReply: (threadId: string, body: string) => Promise<string | null>
}

function ThreadBox({ thread, canReply, onReply }: { thread: CommentThread; canReply: boolean; onReply: DiffViewProps['onReply'] }) {
  const { t, locale } = useI18n()
  const [replying, setReplying] = useState(false)
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const send = async () => {
    setBusy(true)
    const failure = await onReply(thread.id, body)
    setBusy(false)
    setError(failure)
    if (!failure) {
      setBody('')
      setReplying(false)
    }
  }
  return (
    <div className="my-1.5 ml-16 mr-3 rounded-md border border-border bg-surface-raised p-3 font-sans text-base shadow-sm" role="group" aria-label={t('pr.thread.line', { line: thread.line ?? 0 })}>
      {thread.resolved && <Badge tone="success" className="mb-2">{t('pr.thread.resolved')}</Badge>}
      <ul className="flex flex-col gap-2.5">
        {thread.comments.map((c) => (
          <li key={c.id}>
            <div className="flex items-center gap-2 text-sm">
              <span className="font-semibold">{c.author}</span>
              {c.isBot && <Badge>{t('pr.detail.bot')}</Badge>}
              {c.createdAt && <span className="text-subtle">{relativeTime(c.createdAt, Date.now(), locale)}</span>}
            </div>
            <p className="mt-0.5 whitespace-pre-wrap break-words text-base text-text">{c.body}</p>
          </li>
        ))}
      </ul>
      {canReply &&
        (replying ? (
          <div className="mt-3 flex flex-col gap-2">
            <Textarea rows={3} value={body} onChange={(e) => setBody(e.target.value)} placeholder={t('pr.thread.replyPlaceholder')} aria-label={t('pr.thread.replyPlaceholder')} className="font-sans" />
            {error && <p className="text-sm text-danger">{t('pr.action.failed', { message: error })}</p>}
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setReplying(false)}>
                {t('common.cancel')}
              </Button>
              <Button size="sm" variant="primary" disabled={busy || body.trim() === ''} onClick={() => void send()}>
                {busy ? t('pr.action.submitting') : t('pr.thread.send')}
              </Button>
            </div>
          </div>
        ) : (
          <Button size="sm" variant="ghost" className="mt-2" onClick={() => setReplying(true)}>
            {t('pr.thread.reply')}
          </Button>
        ))}
    </div>
  )
}

function FileDiffView({ file, threads, canReply, onReply }: { file: DiffFile; threads: CommentThread[]; canReply: boolean; onReply: DiffViewProps['onReply'] }) {
  const { t } = useI18n()
  const [showAll, setShowAll] = useState(false)
  const total = diffLineCount(file)
  const limited = !showAll && total > MAX_DIFF_LINES
  const byLine = useMemo(() => {
    const map = new Map<number, CommentThread[]>()
    for (const th of threads) if (th.line !== undefined) map.set(th.line, [...(map.get(th.line) ?? []), th])
    return map
  }, [threads])
  const shownThreads = new Set<string>()
  let budget = limited ? MAX_DIFF_LINES : Infinity

  if (file.hunks.length === 0) {
    return <p className="px-4 py-6 text-base text-muted">{file.binary ? t('pr.files.binary') : t('pr.files.none')}</p>
  }
  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full table-fixed border-collapse font-mono text-sm leading-5">
          <colgroup>
            <col className="w-12" />
            <col className="w-12" />
            <col className="w-5" />
            <col />
          </colgroup>
          <tbody>
            {file.hunks.map((hunk, hi) => {
              if (budget <= 0) return null
              return [
                <tr key={`h${hi}`} className="bg-info-soft text-info">
                  <td colSpan={4} className="whitespace-pre-wrap break-all px-3 py-1">
                    {hunk.header}
                  </td>
                </tr>,
                ...hunk.lines.flatMap((line, li) => {
                  if (budget-- <= 0) return []
                  const here = line.kind !== 'removed' && line.newNumber !== undefined ? (byLine.get(line.newNumber) ?? []) : []
                  const rows = [
                    <tr key={`${hi}:${li}`} className={ROW[line.kind]}>
                      <td className="w-12 select-none pr-2 text-right align-top text-subtle tabular-nums">{line.oldNumber ?? ''}</td>
                      <td className="w-12 select-none pr-2 text-right align-top text-subtle tabular-nums">{line.newNumber ?? ''}</td>
                      <td className={cn('w-5 select-none text-center align-top', SIGN_COLOR[line.kind])}>{SIGN[line.kind]}</td>
                      <td className="whitespace-pre-wrap break-all pr-4">{line.text === '' ? ' ' : line.text}</td>
                    </tr>
                  ]
                  for (const th of here) {
                    if (shownThreads.has(th.id)) continue
                    shownThreads.add(th.id)
                    rows.push(
                      <tr key={`t${th.id}`}>
                        <td colSpan={4}>
                          <ThreadBox thread={th} canReply={canReply} onReply={onReply} />
                        </td>
                      </tr>
                    )
                  }
                  return rows
                })
              ]
            })}
          </tbody>
        </table>
      </div>
      {limited && (
        <div className="flex items-center gap-3 border-t border-border px-4 py-2 text-sm text-muted">
          {t('pr.files.tooLong', { shown: MAX_DIFF_LINES, total })}
          <Button size="sm" onClick={() => setShowAll(true)}>
            {t('pr.files.showAll')}
          </Button>
        </div>
      )}
      {threads.filter((th) => !shownThreads.has(th.id)).length > 0 && !limited && (
        <div className="border-t border-border px-4 py-3">
          <h4 className="mb-1 text-sm font-semibold text-muted">{t('pr.files.orphanThreads')}</h4>
          {threads
            .filter((th) => !shownThreads.has(th.id))
            .map((th) => (
              <ThreadBox key={th.id} thread={th} canReply={canReply} onReply={onReply} />
            ))}
        </div>
      )}
    </div>
  )
}

/** Changed files on the left, the selected file's diff on the right, review threads inline under their line. */
export function DiffView({ files, threads, canReply, onReply }: DiffViewProps) {
  const { t, formatNumber } = useI18n()
  const [selected, setSelected] = useState(files[0]?.path ?? '')
  const file = files.find((f) => f.path === selected) ?? files[0]
  if (!file) return <EmptyState compact icon={<FileDiff className="size-5" aria-hidden />} title={t('pr.files.none')} />
  const fileThreads = threads.filter((th) => th.path === file.path)
  return (
    <div className="grid grid-cols-[15rem_minmax(0,1fr)] gap-4">
      <nav aria-label={t('pr.files.list')} className="sticky top-0 max-h-[calc(100vh-14rem)] self-start overflow-y-auto rounded-lg border border-border bg-surface p-1">
        <ul className="flex flex-col gap-0.5">
          {files.map((f) => {
            const count = threads.filter((th) => th.path === f.path).length
            return (
              <li key={f.path}>
                <button
                  type="button"
                  onClick={() => setSelected(f.path)}
                  aria-current={f.path === file.path ? 'true' : undefined}
                  title={f.path}
                  className={cn('flex w-full flex-col rounded-md px-2 py-1.5 text-left text-sm transition-colors duration-150 hover:bg-surface-hover', f.path === file.path && 'bg-accent-soft hover:bg-accent-soft')}
                >
                  <span className="truncate font-medium">{f.path.split('/').pop()}</span>
                  <span className="truncate text-xs text-subtle">{f.path}</span>
                  <span className="mt-0.5 flex items-center gap-2 text-xs tabular-nums">
                    <span className="text-success">+{formatNumber(f.additions)}</span>
                    <span className="text-danger">−{formatNumber(f.deletions)}</span>
                    {count > 0 && <span className="text-muted">· {count}</span>}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </nav>
      <section aria-label={file.path} className="min-w-0 overflow-hidden rounded-lg border border-border bg-surface">
        <header className="flex items-center gap-2 border-b border-border px-4 py-2 text-sm">
          <span className="truncate font-mono font-medium">{file.path}</span>
          <Badge>{t(`pr.files.status.${file.status}`)}</Badge>
          {file.oldPath && <span className="truncate text-subtle">{t('pr.files.renamed', { path: file.oldPath })}</span>}
        </header>
        <FileDiffView key={file.path} file={file} threads={fileThreads} canReply={canReply} onReply={onReply} />
      </section>
    </div>
  )
}
