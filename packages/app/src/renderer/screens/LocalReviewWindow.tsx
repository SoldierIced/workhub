import { AppWindow, ExternalLink, FileText, FolderGit2, GitPullRequest, Search, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  branchLine,
  commentCounts,
  fileKey,
  filterFiles,
  LOOKS_GOOD_MESSAGE,
  removeComment,
  reviewMessage,
  upsertComment,
  type LocalReview,
  type LocalReviewFile,
  type LocalReviewRepo,
  type LocalReviewScope,
  type ReviewComment
} from '@workhub/core'
import type { LocalReviewLoad, LocalReviewSession } from '@shared/local-review-api'
import { Badge, Button, Input, Select, Spinner, TooltipProvider } from '../components/atoms'
import { Dialog, EmptyState, RefreshButton } from '../components/molecules'
import { I18nProvider, useI18n } from '../i18n/I18nProvider'
import { cn } from '../lib/cn'
import { fileName, newCommentId } from '../lib/localReview'
import { usePlatform } from '../lib/platform'
import { matchesShortcut, shortcutLabel } from '../lib/shortcuts'
import { LocalDiff, type Composer } from './localReview/LocalDiff'

const SEND_SHORTCUT = { key: 'Enter' }
const ALL = '__all__'

function Counts({ additions, deletions }: { additions: number; deletions: number }) {
  const { formatNumber } = useI18n()
  return (
    <span className="tabular-nums">
      <span className="text-success">+{formatNumber(additions)}</span> <span className="text-danger">−{formatNumber(deletions)}</span>
    </span>
  )
}

const sum = (files: LocalReviewFile[], k: 'additions' | 'deletions') => files.reduce((n, f) => n + f[k], 0)

function Review({ sessionId }: { sessionId: string }) {
  const { t, tn } = useI18n()
  const platform = usePlatform()
  const sendShortcut = shortcutLabel(SEND_SHORTCUT, platform)
  const [scope, setScope] = useState<LocalReviewScope>('branch')
  const [reloads, setReloads] = useState(0)
  const reload = () => setReloads((n) => n + 1)
  const [result, setResult] = useState<LocalReviewLoad | null>(null)
  const [session, setSession] = useState<LocalReviewSession | null>(null)
  const [loading, setLoading] = useState(true)
  const [comments, setCommentsState] = useState<ReviewComment[]>([])
  const [repoFilter, setRepoFilter] = useState(ALL)
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [composer, setComposer] = useState<Composer | null>(null)
  const [draft, setDraft] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [focusId, setFocusId] = useState<string | null>(null)

  useEffect(() => {
    void window.hub.localReview.comments(sessionId).then(setCommentsState)
  }, [sessionId])

  useEffect(() => {
    let alive = true
    setLoading(true)
    void window.hub.localReview.load(sessionId, scope).then(
      (r) => {
        if (!alive) return
        setResult(r)
        if (r.ok) setSession(r.session)
        setLoading(false)
      },
      (e: unknown) => {
        if (!alive) return
        setResult({ ok: false, reason: 'failed', detail: e instanceof Error ? e.message : String(e) })
        setLoading(false)
      }
    )
    return () => {
      alive = false
    }
  }, [sessionId, scope, reloads])

  // The session's state (closed, renamed) follows the main window's list.
  useEffect(
    () =>
      window.hub.sessions.onChanged((v) => {
        if (v.id !== sessionId) return
        const live = v.state === 'ready' || v.state === 'busy' || v.state === 'starting'
        setSession((s) => (s ? { ...s, label: v.label, agentName: v.agentName, blocker: v.readOnly ? 'readOnly' : live ? undefined : 'closed' } : s))
      }),
    [sessionId]
  )

  useEffect(() => {
    document.title = session ? `${t('localReview.title')} · ${session.label}` : t('localReview.title')
  }, [session, t])

  const review: LocalReview | null = result?.ok ? result.review : null
  const setComments = useCallback(
    (next: ReviewComment[]) => {
      setCommentsState(next)
      void window.hub.localReview.setComments(sessionId, next)
    },
    [sessionId]
  )

  const repos = review?.repos ?? []
  const visibleRepos = repoFilter === ALL ? repos : repos.filter((r) => r.root === repoFilter)
  const allFiles = useMemo(() => repos.flatMap((r) => r.files.map((f) => ({ repo: r, file: f, key: fileKey(r.root, f.path) }))), [repos])
  const current = allFiles.find((x) => x.key === selected) ?? null
  const counts = useMemo(() => commentCounts(comments), [comments])

  // Keep a selection: the first file once loaded, and again when the selected one goes away.
  useEffect(() => {
    if (!review) return
    if (repoFilter !== ALL && !repos.some((r) => r.root === repoFilter)) setRepoFilter(ALL)
    if (!selected || !allFiles.some((x) => x.key === selected)) setSelected(allFiles[0]?.key ?? null)
  }, [review, allFiles, selected, repoFilter, repos])

  const closeComposer = () => {
    setComposer(null)
    setDraft('')
  }

  const commitDraft = (): ReviewComment[] => {
    if (!composer || !current) return comments
    const existing = composer.editing ? comments.find((c) => c.id === composer.editing) : undefined
    const next = upsertComment(
      comments,
      existing
        ? { ...existing, text: draft }
        : { id: newCommentId(), repoRoot: current.repo.root, repoName: current.repo.name, path: current.file.path, side: composer.side, line: composer.line, text: draft, createdAt: Date.now() }
    )
    setComments(next)
    closeComposer()
    return next
  }

  const blocker = session?.blocker
  const sendAll = () => {
    if (blocker) return
    const all = composer && draft.trim() ? commitDraft() : comments
    if (!all.length) return
    void window.hub.localReview.send(sessionId, reviewMessage(all)).then(() => {
      setComments([])
      window.close()
    })
  }

  const looksGood = (tell: boolean) => {
    setConfirming(false)
    if (!tell || blocker) return window.close()
    void window.hub.localReview.send(sessionId, LOOKS_GOOD_MESSAGE).then(() => {
      setComments([])
      window.close()
    })
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (matchesShortcut(e, SEND_SHORTCUT, platform)) {
        e.preventDefault()
        sendAll()
      } else if (e.key === 'Escape' && !confirming) {
        if (composer) closeComposer()
        else window.close()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const agent = session?.agentName ?? ''
  const files = allFiles.length
  const prs = repos.filter((r) => r.pullRequest).length

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-5 py-3">
        <div className="min-w-56 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="text-lg font-semibold">{t('localReview.title')}</h1>
            {session && (
              <Badge className="min-w-0" title={session.cwd}>
                <span className="truncate">{t('localReview.session', { name: session.label })}</span>
              </Badge>
            )}
          </div>
          <div className="mt-0.5 text-xs text-muted">
            {review ? (
              <>
                {[tn('localReview.repoCount', repos.length), tn('localReview.prCount', prs), tn('localReview.fileCount', files)].join(' · ')} ·{' '}
                <Counts additions={sum(allFiles.map((x) => x.file), 'additions')} deletions={sum(allFiles.map((x) => x.file), 'deletions')} />
              </>
            ) : (
              t('localReview.reading')
            )}
          </div>
        </div>
        {loading && review && <Spinner className="size-4" />}
        <div role="radiogroup" aria-label={t('localReview.scope')} title={t('localReview.scopeHint')} className="inline-flex h-8 items-center rounded-md border border-border bg-surface p-0.5">
          {(['branch', 'uncommitted'] as const).map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={scope === s}
              onClick={() => setScope(s)}
              className={cn('inline-flex h-7 items-center rounded px-2.5 text-sm transition-colors duration-150', scope === s ? 'bg-accent-soft font-medium text-text' : 'text-muted hover:text-text')}
            >
              {t(`localReview.scope.${s}`)}
            </button>
          ))}
        </div>
        <RefreshButton size="md" iconClassName="size-4" label={t('localReview.reload')} loading={loading} onRefresh={reload} />
        <Button
          variant={comments.length ? 'primary' : 'secondary'}
          disabled={!!blocker || (comments.length === 0 && !(composer && draft.trim()))}
          title={blocker ? t(`localReview.blocker.${blocker}`) : t('localReview.sendHint', { shortcut: sendShortcut })}
          onClick={sendAll}
          data-testid="review-send"
        >
          {comments.length ? tn('localReview.send', comments.length, { agent }) : t('localReview.sendEmpty', { agent })}
        </Button>
        <Button variant={comments.length ? 'secondary' : 'primary'} title={t('localReview.looksGoodHint')} onClick={() => setConfirming(true)}>
          {t('localReview.looksGood')}
        </Button>
      </header>

      {!result ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-muted">
          <Spinner className="size-4" /> {t('localReview.reading')}
        </div>
      ) : !result.ok ? (
        <EmptyState
          title={result.reason === 'unknownSession' ? t('localReview.unknownSession') : t('localReview.failed', { detail: result.detail ?? '' })}
          action={<RefreshButton variant="button" size="md" iconClassName="size-4" label={t('localReview.reload')} loading={loading} onRefresh={reload} />}
        />
      ) : repos.length === 0 ? (
        result.review.scannedRepos === 0 ? (
          <EmptyState
            icon={<FolderGit2 className="size-6" aria-hidden />}
            title={t('localReview.noRepo')}
            description={t('localReview.noRepoBody', { folder: fileName(result.review.folder) })}
            action={<RefreshButton variant="button" size="md" iconClassName="size-4" label={t('localReview.reload')} loading={loading} onRefresh={reload} />}
          />
        ) : (
          <EmptyState
            icon={<FolderGit2 className="size-6" aria-hidden />}
            title={t('localReview.noChanges')}
            description={scope === 'uncommitted' ? t('localReview.noChangesUncommitted') : t('localReview.noChangesBranch')}
            action={
              scope === 'uncommitted' ? (
                <Button onClick={() => setScope('branch')}>{t('localReview.compareBase')}</Button>
              ) : (
                <RefreshButton variant="button" size="md" iconClassName="size-4" label={t('localReview.reload')} loading={loading} onRefresh={reload} />
              )
            }
          />
        )
      ) : (
        <>
          <RepoCards repos={repos} selected={repoFilter} onSelect={setRepoFilter} counts={comments} />
          <div className="flex min-h-0 flex-1">
            <aside className="flex w-72 shrink-0 flex-col border-r border-border">
              <div className="flex flex-col gap-2 border-b border-border p-2">
                {repos.length > 1 && (
                  <Select
                    aria-label={t('localReview.repos')}
                    value={repoFilter}
                    onChange={setRepoFilter}
                    options={[{ value: ALL, label: t('localReview.allRepos') }, ...repos.map((r) => ({ value: r.root, label: r.name }))]}
                    className="h-8 text-sm"
                  />
                )}
                <div className="relative">
                  <Search className="pointer-events-none absolute top-2 left-2 size-4 text-subtle" aria-hidden />
                  <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t('localReview.filter')} aria-label={t('localReview.filter')} className="pl-7 pr-7 text-sm" />
                  {filter && (
                    <button type="button" aria-label={t('localReview.filterClear')} onClick={() => setFilter('')} className="absolute top-2 right-2 text-subtle hover:text-text">
                      <X className="size-4" aria-hidden />
                    </button>
                  )}
                </div>
              </div>
              <nav aria-label={t('localReview.files')} className="min-h-0 flex-1 overflow-y-auto p-1">
                {visibleRepos.map((repo) => {
                  const shown = filterFiles(repo.files, filter)
                  if (!shown.length) return null
                  return (
                    <div key={repo.root} className="mb-2">
                      {repos.length > 1 && <div className="truncate px-2 py-1 text-xs font-semibold text-subtle">{repo.name}</div>}
                      <ul className="flex flex-col gap-0.5">
                        {shown.map((f) => {
                          const key = fileKey(repo.root, f.path)
                          const n = counts.get(key) ?? 0
                          return (
                            <li key={key}>
                              <button
                                type="button"
                                onClick={() => {
                                  setSelected(key)
                                  closeComposer()
                                }}
                                aria-current={key === selected ? 'true' : undefined}
                                title={f.oldPath ? `${f.path}\n${t('localReview.renamedFrom', { path: f.oldPath })}` : f.path}
                                className={cn('flex w-full flex-col rounded-md px-2 py-1.5 text-left text-sm transition-colors duration-150 hover:bg-surface-hover', key === selected && 'bg-accent-soft hover:bg-accent-soft')}
                              >
                                <span className="flex min-w-0 items-center gap-1.5">
                                  <span className="truncate font-medium">{fileName(f.path)}</span>
                                  {f.untracked && <Badge tone="success">{t('localReview.untracked')}</Badge>}
                                  {n > 0 && (
                                    <Badge tone="accent" className="ml-auto" title={tn('localReview.commentCount', n)}>
                                      {n}
                                    </Badge>
                                  )}
                                </span>
                                <span className="truncate text-xs text-subtle">{f.path}</span>
                                <span className="mt-0.5 text-xs">
                                  <Counts additions={f.additions} deletions={f.deletions} />
                                </span>
                              </button>
                            </li>
                          )
                        })}
                      </ul>
                    </div>
                  )
                })}
                {filter && visibleRepos.every((r) => filterFiles(r.files, filter).length === 0) && <p className="px-2 py-4 text-sm text-muted">{t('localReview.noMatch', { filter })}</p>}
              </nav>
              {comments.length > 0 && (
                <div className="max-h-56 shrink-0 overflow-y-auto border-t border-border p-2">
                  <div className="mb-1 px-1 text-xs font-semibold text-subtle">{t('localReview.toSend', { count: comments.length })}</div>
                  <ul className="flex flex-col gap-0.5">
                    {comments.map((c) => (
                      <li key={c.id}>
                        <button
                          type="button"
                          onClick={() => {
                            setRepoFilter(ALL)
                            setFilter('')
                            setSelected(fileKey(c.repoRoot, c.path))
                            setFocusId(c.id)
                          }}
                          className="w-full rounded-md px-2 py-1 text-left text-xs hover:bg-surface-hover"
                        >
                          <span className="block truncate font-mono text-subtle">
                            {c.repoName} · {c.path}:{c.line}
                          </span>
                          <span className="block truncate text-muted">{c.text}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </aside>
            <section className="min-w-0 flex-1 overflow-y-auto" aria-label={current?.file.path}>
              {current ? (
                <FilePane
                  sessionId={sessionId}
                  repo={current.repo}
                  file={current.file}
                  comments={comments.filter((c) => c.repoRoot === current.repo.root && c.path === current.file.path)}
                  composer={composer}
                  draft={draft}
                  onDraft={setDraft}
                  onOpenComposer={(c, text) => {
                    setComposer(c)
                    setDraft(text)
                  }}
                  onCloseComposer={closeComposer}
                  onCommit={() => void commitDraft()}
                  onRemove={(id) => setComments(removeComment(comments, id))}
                  sendShortcut={sendShortcut}
                  focusId={focusId}
                />
              ) : (
                <EmptyState compact icon={<FileText className="size-5" aria-hidden />} title={t('localReview.pickFile')} />
              )}
            </section>
          </div>
        </>
      )}

      <Dialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('localReview.looksGoodTitle', { agent })}
        description={comments.length ? tn('localReview.looksGoodDrops', comments.length, { message: LOOKS_GOOD_MESSAGE }) : t('localReview.looksGoodBody', { message: LOOKS_GOOD_MESSAGE })}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={() => looksGood(false)}>{t('localReview.closeWithoutSending')}</Button>
            <Button variant="primary" disabled={!!blocker} title={blocker ? t(`localReview.blocker.${blocker}`) : undefined} onClick={() => looksGood(true)}>
              {t('localReview.looksGoodSend')}
            </Button>
          </>
        }
      >
        {blocker && <p className="text-sm text-warning">{t(`localReview.blocker.${blocker}`)}</p>}
      </Dialog>
    </div>
  )
}

/** One card per repo: branch → base, its pull request, a note, its comments. A click narrows the file list to it. */
function RepoCards({ repos, selected, onSelect, counts }: { repos: LocalReviewRepo[]; selected: string; onSelect: (root: string) => void; counts: ReviewComment[] }) {
  const { t, tn } = useI18n()
  return (
    <div className="flex shrink-0 gap-2 overflow-x-auto border-b border-border px-5 py-2" role="list" aria-label={t('localReview.repos')}>
      {repos.map((r) => {
        const n = counts.filter((c) => c.repoRoot === r.root).length
        const active = selected === r.root
        return (
          <button
            key={r.root}
            type="button"
            role="listitem"
            title={[r.root, r.note ? t(`localReview.repoNote.${r.note}`) : ''].filter(Boolean).join('\n')}
            onClick={() => onSelect(active ? ALL : r.root)}
            aria-pressed={active}
            className={cn('flex min-w-52 max-w-80 shrink-0 flex-col rounded-lg border px-3 py-2 text-left text-sm transition-colors duration-150 hover:bg-surface-hover', active ? 'border-accent bg-accent-soft' : 'border-border bg-surface')}
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <FolderGit2 className="size-3.5 shrink-0 text-subtle" aria-hidden />
              <span className="truncate font-semibold">{r.name}</span>
              <span className="ml-auto shrink-0 text-xs">
                <Counts additions={sum(r.files, 'additions')} deletions={sum(r.files, 'deletions')} />
              </span>
            </span>
            <span className="truncate font-mono text-xs text-muted">{branchLine(r, t('localReview.detached'))}</span>
            <span className="flex min-w-0 items-center gap-1.5 text-xs">
              {r.pullRequest ? (
                <span className="inline-flex items-center gap-1 text-text">
                  <GitPullRequest className="size-3" aria-hidden />#{r.pullRequest.number}
                </span>
              ) : r.note ? (
                <span className="truncate text-warning">{t(`localReview.repoNote.${r.note}`)}</span>
              ) : (
                <span className="text-subtle">{t('localReview.noPr')}</span>
              )}
              {n > 0 && <span className="ml-auto shrink-0 text-accent">{tn('localReview.commentCount', n)}</span>}
            </span>
          </button>
        )
      })}
    </div>
  )
}

function FilePane({ sessionId, repo, file, ...diff }: { sessionId: string; repo: LocalReviewRepo; file: LocalReviewFile } & Omit<Parameters<typeof LocalDiff>[0], 'file'>) {
  const { t } = useI18n()
  const viewFile = async () => {
    const path = await window.hub.localReview.filePath(sessionId, repo.root, file.path)
    if (path) void window.hub.files.openWindow(path)
  }
  const openFile = () => void window.hub.localReview.openFile(sessionId, repo.root, file.path)
  const canOpen = file.status !== 'deleted'
  return (
    <div>
      <header className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-border bg-bg px-4 py-2 text-sm">
        <span className="text-xs font-semibold text-subtle">{repo.name}</span>
        <span className="min-w-0 truncate font-mono font-medium" title={file.path}>
          {file.path}
        </span>
        <Badge>{t(`pr.files.status.${file.status}`)}</Badge>
        {file.oldPath && <span className="truncate text-xs text-subtle">{t('localReview.renamedFrom', { path: file.oldPath })}</span>}
        <span className="ml-auto flex items-center gap-1">
          {repo.webUrl && (
            <Button size="sm" variant="ghost" icon={<ExternalLink className="size-3.5" aria-hidden />} onClick={() => window.hub.openExternal(repo.webUrl!)}>
              {repo.pullRequest ? t('localReview.openPr', { number: repo.pullRequest.number }) : t('localReview.openOnGitHub')}
            </Button>
          )}
          {canOpen && (
            <Button size="sm" variant="ghost" icon={<FileText className="size-3.5" aria-hidden />} onClick={() => void viewFile()}>
              {t('localReview.viewFile')}
            </Button>
          )}
          {canOpen && (
            <Button size="sm" variant="ghost" icon={<AppWindow className="size-3.5" aria-hidden />} title={t('localReview.openFileHint')} onClick={openFile}>
              {t('localReview.openFile')}
            </Button>
          )}
        </span>
      </header>
      {file.hunks.length === 0 ? (
        <EmptyState
          compact
          icon={<FileText className="size-5" aria-hidden />}
          title={file.note ? t(`localReview.fileNote.${file.note}`) : t('localReview.noDiff')}
          description={file.status === 'deleted' ? t('localReview.deleted') : t('localReview.noDiff')}
        />
      ) : (
        <LocalDiff file={file} {...diff} />
      )}
    </div>
  )
}

/** The local review window (`#review?session=…`): a session's local changes and the user's comments on them. */
export function LocalReviewWindow({ sessionId }: { sessionId: string }) {
  const platform = usePlatform()
  return (
    <I18nProvider>
      <TooltipProvider>
        <div className="flex h-full flex-col bg-bg">
            {/* Room for the macOS traffic lights; Windows and Linux draw their controls over the right end. */}
            <div className={cn('drag-region h-10 shrink-0', platform === 'mac' ? 'pl-20' : 'pr-36')} />
            <main className="min-h-0 flex-1">
              <Review sessionId={sessionId} />
            </main>
        </div>
      </TooltipProvider>
    </I18nProvider>
  )
}
