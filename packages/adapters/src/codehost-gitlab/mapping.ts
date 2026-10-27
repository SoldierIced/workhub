import {
  diffFileFromHunks,
  type CiStatus,
  type CommentThread,
  type DiffFile,
  type DiffFileStatus,
  type Mergeability,
  type PullRequest,
  type PullRequestCheck,
  type PullRequestComment,
  type PullRequestCommit,
  type PullRequestDetail,
  type PullRequestRef,
  type PullRequestReview,
  type PullRequestState,
  type ReviewDecision
} from '@workhub/core'

type Json = Record<string, unknown>

const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})
const arr = (v: unknown): Json[] => (Array.isArray(v) ? v.map(obj) : [])
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const numeric = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : 0
  return Number.isFinite(n) ? n : 0
}

const epoch = (v: unknown): number | undefined => {
  if (typeof v !== 'string') return undefined
  const t = Date.parse(v)
  return Number.isNaN(t) ? undefined : t
}

const username = (v: unknown): string => str(obj(v)['username'])
const isBot = (user: unknown): boolean => {
  const u = obj(user)
  return u['bot'] === true || /^(project|group)_\d+_bot/.test(str(u['username']))
}

function mapState(v: unknown): PullRequestState {
  return v === 'merged' ? 'merged' : v === 'closed' || v === 'locked' ? 'closed' : 'open'
}

/** GitLab's `detailed_merge_status` carries the review verdict a list does not (approvals need a call per MR). */
function mapDecision(detailed: unknown): ReviewDecision {
  if (detailed === 'requested_changes') return 'changesRequested'
  if (detailed === 'not_approved') return 'reviewRequired'
  return 'none'
}

export function mapPipelineStatus(v: unknown): CiStatus {
  switch (v) {
    case 'success':
    case 'success_with_warnings':
      return 'success'
    case 'failed':
    case 'canceled':
    case 'canceling':
      return 'failure'
    case 'created':
    case 'waiting_for_resource':
    case 'preparing':
    case 'pending':
    case 'running':
    case 'scheduled':
      return 'pending'
    default:
      return 'none'
  }
}

function mapMergeable(mr: Json): Mergeability {
  if (mr['has_conflicts'] === true || mr['detailed_merge_status'] === 'conflict') return 'conflicting'
  if (mr['detailed_merge_status'] === 'mergeable') return 'mergeable'
  return 'unknown'
}

export function mapMergeRequest(value: unknown, ref: PullRequestRef): PullRequest {
  const mr = obj(value)
  const pipeline = obj(mr['head_pipeline'] ?? mr['pipeline'])
  return {
    provider: 'gitlab',
    owner: ref.owner,
    repo: ref.repo,
    number: ref.number,
    url: ref.url,
    title: str(mr['title']),
    author: username(mr['author']),
    branch: str(mr['source_branch']),
    base: str(mr['target_branch']),
    state: mapState(mr['state']),
    isDraft: mr['draft'] === true || mr['work_in_progress'] === true,
    reviewDecision: mapDecision(mr['detailed_merge_status']),
    ci: mapPipelineStatus(pipeline['status']),
    mergeable: mapMergeable(mr),
    // The list API has no line counts; the detail view's diff has them.
    additions: 0,
    deletions: 0,
    changedFiles: numeric(mr['changes_count']),
    updatedAt: epoch(mr['updated_at']),
    headSha: str(mr['sha']) || undefined
  }
}

/** Splits a list answer into merge requests; entries whose URL is not a merge request are skipped. */
export function mapMergeRequestList(pages: readonly unknown[], parse: (url: string) => PullRequestRef | null): PullRequest[] {
  const out: PullRequest[] = []
  for (const page of pages) {
    const mr = obj(page)
    const ref = parse(str(mr['web_url']))
    if (ref) out.push(mapMergeRequest(mr, ref))
  }
  return out
}

/** Discussions: replies to a diff line become threads, the rest is the conversation. */
export function mapDiscussions(pages: readonly unknown[]): { comments: PullRequestComment[]; threads: CommentThread[] } {
  const comments: PullRequestComment[] = []
  const threads: CommentThread[] = []
  for (const d of pages.map(obj)) {
    const notes = arr(d['notes']).filter((n) => n['system'] !== true)
    const first = notes[0]
    if (!first) continue
    if (str(first['type']) === 'DiffNote') {
      const position = obj(first['position'])
      const line = typeof position['new_line'] === 'number' ? position['new_line'] : typeof position['old_line'] === 'number' ? position['old_line'] : undefined
      const path = str(position['new_path'] ?? position['old_path'])
      threads.push({
        id: str(d['id']),
        path,
        line,
        resolved: first['resolvable'] === true ? first['resolved'] === true : undefined,
        comments: notes.map((n) => ({
          id: String(n['id']),
          author: username(n['author']),
          isBot: isBot(n['author']),
          body: str(n['body']),
          path,
          line,
          createdAt: epoch(n['created_at'])
        }))
      })
    } else {
      for (const n of notes) {
        comments.push({ id: String(n['id']), author: username(n['author']), isBot: isBot(n['author']), body: str(n['body']), createdAt: epoch(n['created_at']) })
      }
    }
  }
  const byDate = <T extends { createdAt?: number }>(a: T, b: T) => (a.createdAt ?? 0) - (b.createdAt ?? 0)
  return { comments: comments.sort(byDate), threads: threads.sort((a, b) => (a.comments[0]?.createdAt ?? 0) - (b.comments[0]?.createdAt ?? 0)) }
}

export interface GitLabDetailParts {
  mr: unknown
  approvals: unknown
  discussions: readonly unknown[]
  commits: readonly unknown[]
  jobs: readonly unknown[]
}

function mapJobStatus(v: unknown): CiStatus {
  switch (v) {
    case 'success':
      return 'success'
    case 'failed':
    case 'canceled':
      return 'failure'
    case 'skipped':
    case 'manual':
      return 'none'
    default:
      return 'pending'
  }
}

export function mapDetail(parts: GitLabDetailParts, ref: PullRequestRef): PullRequestDetail {
  const base = mapMergeRequest(parts.mr, ref)
  const mr = obj(parts.mr)
  const approvals = obj(parts.approvals)
  const approvers = arr(approvals['approved_by']).map((a) => username(a['user'])).filter(Boolean)
  const reviews: PullRequestReview[] = approvers.map((author) => ({ id: `approval-${author}`, author, isBot: false, state: 'approved', body: '', submittedAt: undefined }))
  const hasRequestedChanges = mr['detailed_merge_status'] === 'requested_changes'
  const reviewDecision: ReviewDecision = hasRequestedChanges
    ? 'changesRequested'
    : approvers.length > 0 && numeric(approvals['approvals_left']) === 0
      ? 'approved'
      : base.reviewDecision === 'none' && approvers.length === 0
        ? 'none'
        : base.reviewDecision
  const checks: PullRequestCheck[] = parts.jobs
    .map(obj)
    .map((j) => ({ name: str(j['name']) || 'job', status: mapJobStatus(j['status']), url: str(j['web_url']) || undefined }))
    .filter((c) => c.status !== 'none')
  const commits: PullRequestCommit[] = parts.commits.map(obj).map((c) => ({
    sha: str(c['id']),
    headline: str(c['title']),
    author: str(c['author_name']),
    date: epoch(c['committed_date'])
  }))
  const { comments, threads } = mapDiscussions(parts.discussions)
  return {
    ...base,
    reviewDecision,
    body: str(mr['description']),
    labels: Array.isArray(mr['labels']) ? (mr['labels'] as unknown[]).filter((l): l is string => typeof l === 'string') : [],
    requestedReviewers: arr(mr['reviewers']).map((r) => str(r['username'])).filter((u) => u && !approvers.includes(u)),
    createdAt: epoch(mr['created_at']),
    mergedAt: epoch(mr['merged_at']),
    reviews,
    comments,
    threads,
    commits,
    checks
  }
}

/** `projects/:id/merge_requests/:iid/diffs` (or the older `changes`) as diff files. */
export function mapDiffs(entries: readonly unknown[]): DiffFile[] {
  return entries.map(obj).map((e) => {
    const newPath = str(e['new_path'])
    const oldPath = str(e['old_path'])
    const status: DiffFileStatus = e['new_file'] === true ? 'added' : e['deleted_file'] === true ? 'deleted' : e['renamed_file'] === true ? 'renamed' : 'modified'
    const text = str(e['diff'])
    const file = diffFileFromHunks({ path: newPath || oldPath, oldPath: oldPath !== newPath ? oldPath : undefined, status }, text)
    // An empty diff that is not a rename, or one GitLab left out for size, has nothing to show as text.
    const omitted = e['too_large'] === true || e['collapsed'] === true
    return { ...file, binary: file.binary || (text === '' && status !== 'renamed' && !omitted) }
  })
}
