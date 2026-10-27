import { MessageSquarePlus } from 'lucide-react'
import { Fragment, useEffect, useRef } from 'react'
import { commentAnchor, isCommentOn, type CommentSide, type DiffLine, type LocalReviewFile, type ReviewComment } from '@workhub/core'
import { Button, Textarea } from '../../components/atoms'
import { useI18n } from '../../i18n/I18nProvider'
import { cn } from '../../lib/cn'
import { relativeTime } from '../../lib/pullRequests'

const ROW: Record<DiffLine['kind'], string> = { added: 'bg-success-soft', removed: 'bg-danger-soft', context: '' }
const SIGN: Record<DiffLine['kind'], string> = { added: '+', removed: '−', context: ' ' }
const SIGN_COLOR: Record<DiffLine['kind'], string> = { added: 'text-success', removed: 'text-danger', context: 'text-subtle' }

/** The open comment box: on a line of the shown file, for a new comment or to edit one. */
export interface Composer {
  side: CommentSide
  line: number
  editing?: string
}

export interface LocalDiffProps {
  file: LocalReviewFile
  comments: ReviewComment[]
  composer: Composer | null
  draft: string
  onDraft: (text: string) => void
  onOpenComposer: (composer: Composer, text: string) => void
  onCloseComposer: () => void
  onCommit: () => void
  onRemove: (id: string) => void
  /** The key label that sends every comment (⌘Return / Ctrl+Enter). */
  sendShortcut: string
  /** A comment to bring into view. */
  focusId?: string | null
}

function CommentBox({ comment, onEdit, onRemove }: { comment: ReviewComment; onEdit: () => void; onRemove: () => void }) {
  const { t, locale } = useI18n()
  return (
    <div data-comment-id={comment.id} className="my-1.5 ml-24 mr-3 rounded-md border border-border bg-surface-raised p-3 font-sans text-base shadow-sm">
      <div className="flex items-center gap-2 text-sm">
        <span className="font-semibold">{t('localReview.you')}</span>
        <span className="text-subtle">
          {t(comment.side === 'new' ? 'localReview.onLine' : 'localReview.onRemovedLine', { line: comment.line })} · {relativeTime(comment.createdAt, Date.now(), locale)}
        </span>
        <span className="text-subtle">· {t('localReview.notSent')}</span>
        <span className="ml-auto flex gap-1">
          <Button size="sm" variant="ghost" onClick={onEdit}>
            {t('localReview.edit')}
          </Button>
          <Button size="sm" variant="ghost" className="text-danger" onClick={onRemove}>
            {t('localReview.remove')}
          </Button>
        </span>
      </div>
      <p className="mt-1 whitespace-pre-wrap break-words text-text">{comment.text}</p>
    </div>
  )
}

function ComposerBox({ composer, draft, onDraft, onCancel, onCommit, sendShortcut }: { composer: Composer; draft: string; onDraft: (s: string) => void; onCancel: () => void; onCommit: () => void; sendShortcut: string }) {
  const { t } = useI18n()
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.scrollIntoView({ block: 'nearest' })
  }, [composer.line, composer.side, composer.editing])
  return (
    <div className="my-1.5 ml-24 mr-3 rounded-md border border-accent/50 bg-surface-raised p-3 font-sans text-base shadow-sm" data-testid="review-composer">
      <div className="mb-1.5 text-sm text-muted">
        <span className="font-semibold text-text">{t('localReview.you')}</span> · {t(composer.side === 'new' ? 'localReview.onLine' : 'localReview.onRemovedLine', { line: composer.line })}
      </div>
      <Textarea
        ref={ref}
        rows={3}
        value={draft}
        placeholder={t('localReview.commentPlaceholder')}
        aria-label={t('localReview.addComment', { line: composer.line })}
        className="font-sans"
        onChange={(e) => onDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            onCancel()
          } else if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            onCommit()
          }
        }}
      />
      <div className="mt-2 flex items-center gap-2">
        <span className="text-xs text-subtle">{t('localReview.composerHint', { shortcut: sendShortcut })}</span>
        <span className="ml-auto flex gap-2">
          <Button size="sm" variant="ghost" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" disabled={draft.trim() === ''} onClick={onCommit}>
            {composer.editing ? t('localReview.save') : t('localReview.add')}
          </Button>
        </span>
      </div>
    </div>
  )
}

/** One file's diff with the user's comments under their lines; a line's "+" opens a comment box. */
export function LocalDiff({ file, comments, composer, draft, onDraft, onOpenComposer, onCloseComposer, onCommit, onRemove, sendShortcut, focusId }: LocalDiffProps) {
  const { t, tn } = useI18n()
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!focusId) return
    root.current?.querySelector(`[data-comment-id="${CSS.escape(focusId)}"]`)?.scrollIntoView({ block: 'center' })
  }, [focusId])
  const shown = new Set<string>()
  return (
    <div ref={root}>
      <div className="overflow-x-auto">
        <table className="w-full table-fixed border-collapse font-mono text-sm leading-5">
          <colgroup>
            <col className="w-7" />
            <col className="w-12" />
            <col className="w-12" />
            <col className="w-5" />
            <col />
          </colgroup>
          <tbody>
            {file.hunks.map((hunk, hi) => (
              <Fragment key={`h${hi}`}>
                <tr className="bg-info-soft text-info">
                  <td colSpan={5} className="whitespace-pre-wrap break-all px-3 py-1">
                    {hunk.header}
                  </td>
                </tr>
                {hunk.lines.map((line, li) => {
                  const anchor = commentAnchor(line)
                  const here = comments.filter((c) => isCommentOn(c, line))
                  const composing = composer && anchor && composer.side === anchor.side && composer.line === anchor.line
                  return (
                    <Fragment key={`${hi}:${li}`}>
                      <tr className={cn('group', ROW[line.kind])}>
                        <td className="select-none align-top">
                          {anchor && (
                            <button
                              type="button"
                              aria-label={t('localReview.addComment', { line: anchor.line })}
                              title={t('localReview.addComment', { line: anchor.line })}
                              onClick={() => onOpenComposer({ side: anchor.side, line: anchor.line }, '')}
                              className={cn('flex size-5 items-center justify-center rounded-sm text-accent opacity-0 hover:bg-accent-soft focus-visible:opacity-100 group-hover:opacity-100', here.length > 0 && 'opacity-60')}
                            >
                              <MessageSquarePlus className="size-3.5" aria-hidden />
                            </button>
                          )}
                        </td>
                        <td className="select-none pr-2 text-right align-top text-subtle tabular-nums">{line.oldNumber ?? ''}</td>
                        <td className="select-none pr-2 text-right align-top text-subtle tabular-nums">{line.newNumber ?? ''}</td>
                        <td className={cn('select-none text-center align-top', SIGN_COLOR[line.kind])}>{SIGN[line.kind]}</td>
                        <td className="whitespace-pre-wrap break-all pr-4">{line.text === '' ? ' ' : line.text}</td>
                      </tr>
                      {here.map((c) => {
                        shown.add(c.id)
                        return composer?.editing === c.id ? null : (
                          <tr key={c.id}>
                            <td colSpan={5}>
                              <CommentBox comment={c} onEdit={() => onOpenComposer({ side: c.side, line: c.line, editing: c.id }, c.text)} onRemove={() => onRemove(c.id)} />
                            </td>
                          </tr>
                        )
                      })}
                      {composing && (
                        <tr>
                          <td colSpan={5}>
                            <ComposerBox composer={composer} draft={draft} onDraft={onDraft} onCancel={onCloseComposer} onCommit={onCommit} sendShortcut={sendShortcut} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      {file.hiddenLines > 0 && <p className="border-t border-border px-4 py-2 text-sm text-muted">{tn('localReview.hiddenLines', file.hiddenLines)}</p>}
      {comments.some((c) => !shown.has(c.id)) && (
        <div className="border-t border-border py-2">
          {comments
            .filter((c) => !shown.has(c.id))
            .map((c) =>
              composer?.editing === c.id ? (
                <ComposerBox key={c.id} composer={composer} draft={draft} onDraft={onDraft} onCancel={onCloseComposer} onCommit={onCommit} sendShortcut={sendShortcut} />
              ) : (
                <CommentBox key={c.id} comment={c} onEdit={() => onOpenComposer({ side: c.side, line: c.line, editing: c.id }, c.text)} onRemove={() => onRemove(c.id)} />
              )
            )}
        </div>
      )}
    </div>
  )
}
