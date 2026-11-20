import { RefreshCw, WrapText } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { LocalReviewScope } from '@workhub/core'
import { Spinner } from '../../renderer/components/atoms'
import { useI18n } from '../../renderer/i18n/I18nProvider'
import { cn } from '../../renderer/lib/cn'
import { useSessions } from '../../renderer/store'
import type { RemoteChangedFile, RemoteChangedRepo, RemoteChangesPage, RemoteDiffPage, RemoteDiffPiece } from '../../shared/remote-changes-api'
import { useClient, useClientStatus } from '../app-context'
import { PHONE_TEXT_SCALE } from '../appearance'
import { addFiles, addPieces, fileKey, fileParts } from '../changes-pages'
import { PathText } from '../path-text'
import { ACTION_BUTTON, Body, Header, IconButton, Screen } from '../ui'
import { ReviewCard, useRemoteReview } from './ReviewCard'
import { sessionTitle } from './HomeScreen'

/** Files asked for per page; a page also stops early to fit the relay's frame. */
const FILES_PAGE = 100
const PIECES_PAGE = 20

const STATUS_TONE: Record<RemoteChangedFile['status'], string> = { added: 'text-success', deleted: 'text-danger', renamed: 'text-info', modified: 'text-warning' }
const STATUS_LETTER: Record<RemoteChangedFile['status'], string> = { added: 'A', deleted: 'D', renamed: 'R', modified: 'M' }

type ListState =
  | { state: 'loading' }
  | { state: 'failed'; reason: 'unknownSession' | 'failed' | 'offline' }
  | { state: 'ready'; repos: RemoteChangedRepo[]; files: RemoteChangedFile[]; total: number; cursor: string | null; more: boolean }

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** One file's diff, a page of hunks at a time; a binary, hidden or too-large file shows why instead. */
/** A diff's text size: 13 px at the phone's normal text size, growing with the Text size setting. */
const DIFF_FONT = { fontSize: `calc(13px * var(--wh-text-scale, 1) / ${PHONE_TEXT_SCALE})` }

function DiffView({ sessionId, scope, file, wrap }: { sessionId: string; scope: LocalReviewScope; file: RemoteChangedFile; wrap: boolean }) {
  const { t, tn } = useI18n()
  const client = useClient()
  const [pieces, setPieces] = useState<RemoteDiffPiece[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [meta, setMeta] = useState<RemoteChangedFile>(file)
  const read = async (after: string | null) => {
    setLoading(true)
    setError(null)
    try {
      const page = (await client.transport.invoke('remote:diff', sessionId, { scope, repo: file.repo, path: file.path, limit: PIECES_PAGE, ...(after ? { cursor: after } : {}) })) as RemoteDiffPage
      setMeta(page.file)
      setPieces((have) => addPieces(after ? have : [], page.pieces.items))
      setCursor(page.pieces.nextCursor)
    } catch (err) {
      setError(t('web.changes.diffFailed', { error: errorText(err) }))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    void read(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, scope, file.repo, file.path])
  const note = meta.note
  return (
    <div className="flex flex-col gap-2" data-testid="remote-diff">
      {note && <p className="rounded-lg bg-surface px-3 py-2 text-xs text-muted" data-testid="remote-diff-note">{note === 'hidden' ? t('web.changes.hidden') : t(`localReview.fileNote.${note}`)}</p>}
      {!note && !loading && !error && pieces.length === 0 && <p className="text-sm text-muted">{meta.status === 'deleted' ? t('localReview.deleted') : t('localReview.noDiff')}</p>}
      {pieces.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-border bg-bg font-mono" style={DIFF_FONT} data-testid="remote-diff-lines" data-wrap={wrap}>
          {pieces.map((p) => (
            <div key={`${p.hunk}:${p.start}`}>
              {p.start === 0 && <div className={cn('bg-surface px-2 py-1 text-info', wrap ? 'whitespace-pre-wrap [overflow-wrap:anywhere]' : 'whitespace-pre')}>{p.header}</div>}
              {p.lines.map((line, i) => (
                <div key={i} className={cn('flex', !wrap && 'whitespace-pre', line.kind === 'added' && 'bg-success-soft', line.kind === 'removed' && 'bg-danger-soft')}>
                  <span className="w-10 shrink-0 pr-1 text-right text-subtle select-none">{line.kind === 'removed' ? line.oldNumber : line.newNumber}</span>
                  <span className="w-3 shrink-0 select-none text-subtle">{line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '}</span>
                  <span className={cn('pr-2', wrap && 'min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]')}>{line.text}</span>
                </div>
              ))}
              {p.cutLines ? <div className="px-2 py-0.5 font-sans text-subtle">{tn('web.changes.cutLines', p.cutLines)}</div> : null}
            </div>
          ))}
        </div>
      )}
      {!cursor && !loading && meta.hiddenLines > 0 && <p className="text-xs text-subtle">{tn('localReview.hiddenLines', meta.hiddenLines)}</p>}
      {error && <p className="text-xs text-danger">{error}</p>}
      {loading ? (
        <Spinner className="mx-auto size-4" />
      ) : (
        (cursor || error) && (
          <button type="button" onClick={() => void read(error && !cursor ? null : cursor)} className={cn(ACTION_BUTTON, 'mx-auto rounded-full text-muted')}>
            {error ? t('web.changes.retry') : t('web.changes.loadMore')}
          </button>
        )
      )}
    </div>
  )
}

function FileRow({ file, onOpen }: { file: RemoteChangedFile; onOpen: () => void }) {
  const { name, dir } = fileParts(file.path)
  return (
    <button type="button" onClick={onOpen} className="flex min-h-14 w-full items-center gap-2 border-b border-border px-1 py-2 text-left text-sm active:bg-surface-hover" data-testid="remote-changed-file" title={file.path}>
      <span className={cn('w-4 shrink-0 self-start pt-0.5 text-center font-mono font-semibold', STATUS_TONE[file.status])}>{STATUS_LETTER[file.status]}</span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        {/* The name is the part you look for: it wraps instead of being cut. */}
        <span className="font-mono font-semibold [overflow-wrap:anywhere]" data-testid="remote-changed-name">
          {name}
        </span>
        {dir && <PathText path={dir} className="text-xs text-muted" />}
      </span>
      <span className="shrink-0 font-mono tabular-nums text-success">+{file.additions}</span>
      <span className="shrink-0 font-mono tabular-nums text-danger">-{file.deletions}</span>
    </button>
  )
}

/** What a session changed in its repositories, a file's diff, and its review loop. Read only, but for the loop's decisions. */
export function ChangesScreen({ sessionId }: { sessionId: string }) {
  const { t, tn } = useI18n()
  const client = useClient()
  const online = useClientStatus().state === 'online'
  const session = useSessions()[sessionId]
  const [scope, setScope] = useState<LocalReviewScope>('branch')
  const [list, setList] = useState<ListState>({ state: 'loading' })
  const [open, setOpen] = useState<RemoteChangedFile | null>(null)
  // Long lines wrap unless the person switches it off; the choice stays across files.
  const [wrap, setWrap] = useState(true)
  const [generation, setGeneration] = useState(0)
  const reading = useRef(0)
  const review = useRemoteReview(sessionId, session?.view.state)

  useEffect(() => {
    if (!online) {
      setList((prev) => (prev.state === 'ready' ? prev : { state: 'failed', reason: 'offline' }))
      return
    }
    const mine = ++reading.current
    setList({ state: 'loading' })
    ;(client.transport.invoke('remote:changes', sessionId, { scope, limit: FILES_PAGE }) as Promise<RemoteChangesPage>).then(
      (page) => {
        if (reading.current !== mine) return
        setList(page.ok ? { state: 'ready', repos: page.repos, files: addFiles([], page.files.items), total: page.files.total, cursor: page.files.nextCursor, more: false } : { state: 'failed', reason: page.reason })
      },
      () => reading.current === mine && setList({ state: 'failed', reason: 'failed' })
    )
  }, [client, sessionId, scope, online, generation])

  const loadMore = async () => {
    if (list.state !== 'ready' || !list.cursor || list.more) return
    const mine = reading.current
    setList({ ...list, more: true })
    try {
      const page = (await client.transport.invoke('remote:changes', sessionId, { scope, limit: FILES_PAGE, cursor: list.cursor })) as RemoteChangesPage
      if (reading.current !== mine) return
      setList((prev) => (prev.state === 'ready' && page.ok ? { ...prev, files: addFiles(prev.files, page.files.items), total: page.files.total, cursor: page.files.nextCursor, more: false } : prev.state === 'ready' ? { ...prev, more: false } : prev))
    } catch {
      setList((prev) => (prev.state === 'ready' ? { ...prev, more: false } : prev))
    }
  }

  // A file's diff is not a history entry of its own: the header's back closes it, and any other way out of the screen leaves nothing behind.
  const title = session ? sessionTitle(session) : t('web.changes.title')
  if (open) {
    return (
      <Screen>
        <Header
          title={<span className="font-mono text-base [overflow-wrap:anywhere]">{fileParts(open.path).name}</span>}
          subtitle={<PathText path={`${open.repo}/${fileParts(open.path).dir}`} />}
          back={() => setOpen(null)}
          right={
            <IconButton aria-label={t('web.changes.wrap')} aria-pressed={wrap} onClick={() => setWrap((v) => !v)} className={cn('rounded-lg', wrap && 'bg-surface-raised text-text')} data-testid="diff-wrap">
              <WrapText className="size-5" aria-hidden />
            </IconButton>
          }
        />
        <Body className="px-3 py-3">
          {open.oldPath && <p className="mb-2 truncate font-mono text-xs text-subtle">{t('localReview.renamedFrom', { path: open.oldPath })}</p>}
          <DiffView key={fileKey(open)} sessionId={sessionId} scope={scope} file={open} wrap={wrap} />
        </Body>
      </Screen>
    )
  }

  return (
    <Screen>
      <Header
        title={t('web.changes.title')}
        subtitle={title}
        back={{ screen: 'session', id: sessionId }}
        right={
          <IconButton aria-label={t('web.changes.refresh')} disabled={!online} onClick={() => { setGeneration((n) => n + 1); review.reload() }}>
            <RefreshCw className="size-5" aria-hidden />
          </IconButton>
        }
      />
      <Body className="px-4 py-3">
        <div className="flex flex-col gap-3">
          {review.state && <ReviewCard sessionId={sessionId} state={review.state} onDone={review.reload} />}
          <div role="group" aria-label={t('localReview.scope')} className="grid grid-cols-2 gap-1 rounded-xl border border-border p-1 text-sm">
            {(['branch', 'uncommitted'] as const).map((s) => (
              <button key={s} type="button" aria-pressed={scope === s} onClick={() => setScope(s)} className={cn('min-h-11 rounded-lg px-2 py-1', scope === s ? 'bg-surface-raised font-semibold text-text' : 'text-muted')}>
                {t(`localReview.scope.${s}`)}
              </button>
            ))}
          </div>
          {list.state === 'loading' && (
            <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted">
              <Spinner className="size-4" />
              {t('web.changes.loading')}
            </div>
          )}
          {list.state === 'failed' && (
            <p className="py-6 text-center text-sm text-muted">
              {list.reason === 'unknownSession' ? t('web.session.missing') : list.reason === 'offline' ? t('web.changes.offline') : t('web.changes.failed')}
            </p>
          )}
          {list.state === 'ready' && (
            <>
              {list.repos.map((r) => (
                <div key={r.key} className="text-xs text-subtle">
                  <span className="font-semibold text-muted">{r.name}</span>
                  {r.branch ? ` · ${r.branch}` : ` · ${t('localReview.detached')}`}
                  {r.base ? ` · ${t('web.changes.against', { base: r.base })}` : ''} · {tn('web.changes.files', r.files)}
                  {r.note && <div className="text-warning">{t(`localReview.repoNote.${r.note}`)}</div>}
                </div>
              ))}
              {list.total === 0 ? (
                <div className="py-6 text-center text-sm text-muted">
                  <p>{scope === 'uncommitted' ? t('localReview.noChangesUncommitted') : t('localReview.noChangesBranch')}</p>
                  <p className="mt-1 text-subtle">{t('web.changes.emptyHint')}</p>
                </div>
              ) : (
                <div>
                  {list.files.map((f) => (
                    <FileRow key={fileKey(f)} file={f} onOpen={() => setOpen(f)} />
                  ))}
                </div>
              )}
              {list.cursor && (
                <button type="button" onClick={() => void loadMore()} disabled={list.more || !online} className={cn(ACTION_BUTTON, 'mx-auto rounded-full text-muted')}>
                  {list.more && <Spinner className="size-3.5" />}
                  {t('web.changes.loadMore')}
                </button>
              )}
            </>
          )}
        </div>
      </Body>
    </Screen>
  )
}
