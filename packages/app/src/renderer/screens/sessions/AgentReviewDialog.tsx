import { useEffect, useState } from 'react'
import { REVIEW_TARGET_KINDS, type ReviewTargetKind, type ReviewTargetRequest } from '@workhub/core'
import type { SessionView } from '@shared/api'
import type { AgentReviewBlocker, AgentReviewOptions } from '@shared/ai-review-api'
import { AgentIcon, Button, Input, Select, Spinner } from '../../components/atoms'
import { Dialog, Field, useToast } from '../../components/molecules'
import { useI18n } from '../../i18n/I18nProvider'
import type { MessageKey } from '../../i18n/translate'
import { requestOpen } from '../../lib/continuity'
import { errorText } from '../../lib/errorText'

/** Every reason the reviewer did not start, as an actionable message (`{detail}` names the folder, commit or gh's own words). */
export const AGENT_REVIEW_ERROR: Record<AgentReviewBlocker, MessageKey> = {
  noRepo: 'agentReview.error.noRepo',
  notRepo: 'agentReview.error.notRepo',
  noHead: 'agentReview.error.noHead',
  noChanges: 'agentReview.error.noChanges',
  noBase: 'agentReview.error.noBase',
  noCommits: 'agentReview.error.noCommits',
  badRange: 'agentReview.error.badRange',
  unknownCommit: 'agentReview.error.unknownCommit',
  badPr: 'agentReview.error.badPr',
  prNeedsRepo: 'agentReview.error.prNeedsRepo',
  prNoRemote: 'agentReview.error.prNoRemote',
  prNotGitHub: 'agentReview.error.prNotGitHub',
  ghMissing: 'agentReview.error.ghMissing',
  ghSignedOut: 'agentReview.error.ghSignedOut',
  prNotFound: 'agentReview.error.prNotFound',
  ghFailed: 'agentReview.error.ghFailed',
  unknownSession: 'agentReview.error.unknownSession',
  reviewerSession: 'agentReview.error.reviewerSession',
  noReviewer: 'agentReview.error.noReviewer',
  reviewerMissing: 'agentReview.error.reviewerMissing',
  startFailed: 'agentReview.error.startFailed',
  badRequest: 'agentReview.error.badRequest'
}

const KIND_LABEL: Record<ReviewTargetKind, MessageKey> = {
  uncommitted: 'agentReview.kind.uncommitted',
  branch: 'agentReview.kind.branch',
  pr: 'agentReview.kind.pr',
  commits: 'agentReview.kind.commits'
}

/** The repository select's "type a folder" entry. */
const OTHER = '__other__'

/**
 * "Review with another agent": pick a repository the session touched (or any folder), what to
 * review in it and the reviewer; main starts the reviewer as a read-only session and it is shown.
 * `onLoop` runs the automatic review loop on the session's own branch instead.
 */
export function AgentReviewDialog({ view, open, onOpenChange, onLoop }: { view: SessionView; open: boolean; onOpenChange: (open: boolean) => void; onLoop: () => void }) {
  const { t } = useI18n()
  const toast = useToast()
  const [options, setOptions] = useState<AgentReviewOptions | null>(null)
  const [loading, setLoading] = useState(false)
  const [repo, setRepo] = useState('')
  const [folder, setFolder] = useState('')
  const [kind, setKind] = useState<ReviewTargetKind>('branch')
  const [base, setBase] = useState('')
  const [pr, setPr] = useState('')
  const [range, setRange] = useState('')
  const [reviewerKey, setReviewerKey] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setError('')
    setLoading(true)
    let alive = true
    void window.hub.aiReview
      .targetOptions(view.id)
      .then(
        (o) => {
          if (!alive) return
          setOptions(o)
          const first = o?.repos[0]
          setRepo(first?.root ?? OTHER)
          // Uncommitted work is what a session usually wants reviewed; else its branch.
          setKind(first && first.dirtyFiles > 0 ? 'uncommitted' : 'branch')
          setReviewerKey((k) => (o?.reviewers.some((r) => r.key === k) ? k : (o?.defaultReviewerKey ?? '')))
        },
        (e: unknown) => alive && setError(errorText(e))
      )
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [open, view.id])

  const repoPath = repo === OTHER ? folder.trim() : repo
  const reviewer = options?.reviewers.find((r) => r.key === reviewerKey)
  const ghBlocked = kind === 'pr' && options !== null && options.gh !== 'ready'
  const value = kind === 'pr' ? pr.trim() : kind === 'commits' ? range.trim() : 'ok'
  // A pull request URL needs no repository; everything else does.
  const canStart = !busy && !loading && reviewer !== undefined && reviewer.installed && !ghBlocked && value !== '' && (repoPath !== '' || kind === 'pr')

  const target = (): ReviewTargetRequest => {
    if (kind === 'uncommitted') return { kind, repo: repoPath }
    if (kind === 'branch') return { kind, repo: repoPath, ...(base.trim() ? { base: base.trim() } : {}) }
    if (kind === 'pr') return { kind, pr: pr.trim(), ...(repoPath ? { repo: repoPath } : {}) }
    return { kind, repo: repoPath, range: range.trim() }
  }

  const start = async () => {
    if (!canStart) return
    setError('')
    setBusy(true)
    try {
      const r = await window.hub.aiReview.startAgentReview(view.id, { reviewerKey, target: target() })
      if (!r.ok) {
        setError(t(AGENT_REVIEW_ERROR[r.reason], { detail: r.detail ?? '' }))
        return
      }
      onOpenChange(false)
      requestOpen(r.sessionId)
      toast(t('agentReview.started', { reviewer: reviewer?.label ?? '' }))
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const repos = options?.repos ?? []
  const repoLabel = (r: (typeof repos)[number]) =>
    [r.name, r.branch, r.touched ? t('agentReview.repoTouched') : null, r.dirtyFiles ? t('agentReview.repoDirty', { n: r.dirtyFiles }) : null].filter(Boolean).join(' · ')

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('agentReview.title')}
      description={t('agentReview.description')}
      footer={
        <>
          <Button variant="ghost" className="mr-auto" title={t('agentReview.loopHint')} data-testid="agent-review-loop" onClick={() => {
              onOpenChange(false)
              onLoop()
            }}>
            {t('agentReview.loop')}
          </Button>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={!canStart} data-testid="agent-review-start" icon={busy ? <Spinner className="size-3" /> : undefined} onClick={() => void start()}>
            {t('agentReview.start')}
          </Button>
        </>
      }
    >
      {loading ? (
        <p className="flex items-center gap-2 text-sm text-muted">
          <Spinner className="size-3" /> {t('agentReview.loading')}
        </p>
      ) : (
        <form
          className="flex flex-col gap-4"
          data-testid="agent-review-dialog"
          onSubmit={(e) => {
            e.preventDefault()
            void start()
          }}
        >
          <Field label={t('agentReview.repo')} hint={repos.length === 0 ? <span className="text-warning">{t('agentReview.noTouched')}</span> : undefined}>
            <Select
              aria-label={t('agentReview.repo')}
              value={repo}
              onChange={setRepo}
              options={[...repos.map((r) => ({ value: r.root, label: repoLabel(r) })), { value: OTHER, label: t('agentReview.repoOther') }]}
            />
          </Field>
          {repo === OTHER && (
            <Field label={t('agentReview.repoFolder')} hint={kind === 'pr' ? t('agentReview.repoFolderPrHint') : undefined}>
              <Input value={folder} onChange={(e) => setFolder(e.target.value)} spellCheck={false} placeholder={view.cwd} data-testid="agent-review-folder" />
            </Field>
          )}
          <Field label={t('agentReview.target')}>
            <Select aria-label={t('agentReview.target')} value={kind} onChange={(v) => setKind(v as ReviewTargetKind)} options={REVIEW_TARGET_KINDS.map((k) => ({ value: k, label: t(KIND_LABEL[k]) }))} />
          </Field>
          {kind === 'branch' && (
            <Field label={t('agentReview.base')} hint={t('agentReview.baseHint', { base: options?.baseBranch ?? '' })}>
              <Input value={base} onChange={(e) => setBase(e.target.value)} spellCheck={false} placeholder={options?.baseBranch} />
            </Field>
          )}
          {kind === 'pr' && (
            <Field
              label={t('agentReview.pr')}
              hint={ghBlocked ? <span className="text-warning" data-testid="agent-review-gh">{t(options?.gh === 'missing' ? 'agentReview.gh.missing' : 'agentReview.gh.signedOut')}</span> : t('agentReview.prHint')}
            >
              <Input value={pr} onChange={(e) => setPr(e.target.value)} spellCheck={false} placeholder={t('agentReview.prPlaceholder')} data-testid="agent-review-pr" />
            </Field>
          )}
          {kind === 'commits' && (
            <Field label={t('agentReview.range')} hint={t('agentReview.rangeHint')}>
              <Input value={range} onChange={(e) => setRange(e.target.value)} spellCheck={false} placeholder={t('agentReview.rangePlaceholder')} data-testid="agent-review-range" />
            </Field>
          )}
          <Field
            label={t('agentReview.reviewer')}
            hint={
              !options?.reviewers.length ? (
                t('agentReview.noReviewers')
              ) : reviewer && !reviewer.installed ? (
                <span className="text-warning">{t('agentReview.error.reviewerMissing', { detail: reviewer.label })}</span>
              ) : undefined
            }
          >
            <Select
              aria-label={t('agentReview.reviewer')}
              value={reviewerKey}
              onChange={setReviewerKey}
              placeholder={t('agentReview.noReviewers')}
              options={(options?.reviewers ?? []).map((r) => ({
                value: r.key,
                icon: <AgentIcon agentId={r.agentId} adapter={r.adapter} />,
                label: r.installed ? r.label : `${r.label} (${t('agentReview.notInstalled')})`
              }))}
            />
          </Field>
          {error && (
            <p role="alert" className="text-sm text-danger" data-testid="agent-review-error">
              {error}
            </p>
          )}
        </form>
      )}
    </Dialog>
  )
}
