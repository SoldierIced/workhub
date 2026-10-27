import type {
  CiStatus,
  CommentThread,
  InlineComment,
  Mergeability,
  PullRequest,
  PullRequestCheck,
  PullRequestComment,
  PullRequestCommit,
  PullRequestDetail,
  PullRequestRef,
  PullRequestReview,
  PullRequestState,
  ReviewDecision
} from '@workhub/core'

type Json = Record<string, unknown>

const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})
const arr = (v: unknown): Json[] => (Array.isArray(v) ? v.map(obj) : [])
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number => (typeof v === 'number' ? v : 0)

export function epoch(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined
  const t = Date.parse(v)
  return Number.isNaN(t) ? undefined : t
}

const login = (v: unknown): string => str(obj(v)['login'])
const isBot = (author: unknown, type?: unknown): boolean => {
  const a = obj(author)
  return a['is_bot'] === true || a['__typename'] === 'Bot' || type === 'Bot' || str(a['login']).endsWith('[bot]')
}

export function mapDecision(v: unknown): ReviewDecision {
  switch (v) {
    case 'APPROVED':
      return 'approved'
    case 'CHANGES_REQUESTED':
      return 'changesRequested'
    case 'REVIEW_REQUIRED':
      return 'reviewRequired'
    default:
      return 'none'
  }
}

/** The rollup state of a commit (GraphQL `StatusState`). */
export function mapRollup(v: unknown): CiStatus {
  switch (v) {
    case 'SUCCESS':
      return 'success'
    case 'FAILURE':
    case 'ERROR':
      return 'failure'
    case 'PENDING':
    case 'EXPECTED':
      return 'pending'
    default:
      return 'none'
  }
}

export function mapMergeable(v: unknown): Mergeability {
  return v === 'MERGEABLE' ? 'mergeable' : v === 'CONFLICTING' ? 'conflicting' : 'unknown'
}

function mapState(v: unknown): PullRequestState {
  return v === 'MERGED' ? 'merged' : v === 'CLOSED' ? 'closed' : 'open'
}

/** One search result node of the GraphQL query in `host.ts`. Null for nodes that are not pull requests. */
export function mapSearchNode(node: unknown, provider = 'github'): PullRequest | null {
  const n = obj(node)
  const number = num(n['number'])
  const url = str(n['url'])
  if (!number || !url) return null
  const repository = obj(n['repository'])
  const commit = obj(obj(arr(obj(n['commits'])['nodes'])[0])['commit'])
  return {
    provider,
    owner: login(repository['owner']),
    repo: str(repository['name']),
    number,
    url,
    title: str(n['title']),
    author: login(n['author']),
    branch: str(n['headRefName']),
    base: str(n['baseRefName']),
    state: mapState(n['state']),
    isDraft: n['isDraft'] === true,
    reviewDecision: mapDecision(n['reviewDecision']),
    ci: mapRollup(obj(commit['statusCheckRollup'])['state']),
    mergeable: mapMergeable(n['mergeable']),
    additions: num(n['additions']),
    deletions: num(n['deletions']),
    changedFiles: num(n['changedFiles']),
    updatedAt: epoch(n['updatedAt']),
    headSha: str(commit['oid']) || undefined,
    commentCount: commentCountOf(n)
  }
}

/** Conversation comments plus review threads, so a new comment moves it; undefined when the node carries neither count. */
function commentCountOf(node: Record<string, unknown>): number | undefined {
  const comments = obj(node['comments'])['totalCount']
  const threads = obj(node['reviewThreads'])['totalCount']
  if (typeof comments !== 'number' && typeof threads !== 'number') return undefined
  return num(comments) + num(threads)
}

export function mapSearchResponse(stdout: string, provider = 'github'): PullRequest[] {
  const root = obj(JSON.parse(stdout))
  const nodes = arr(obj(obj(root['data'])['search'])['nodes'])
  return nodes.map((n) => mapSearchNode(n, provider)).filter((p): p is PullRequest => p !== null)
}

/** Check runs (`conclusion`/`status`) and commit statuses (`state`) share one status scale. */
export function mapCheckStatus(check: Json): CiStatus {
  const conclusion = str(check['conclusion']).toUpperCase()
  if (conclusion) {
    if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(conclusion)) return 'success'
    if (['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(conclusion)) return 'failure'
    return 'pending'
  }
  const state = str(check['state']).toUpperCase()
  if (state === 'SUCCESS') return 'success'
  if (state === 'FAILURE' || state === 'ERROR') return 'failure'
  return 'pending'
}

export function combineChecks(checks: readonly PullRequestCheck[]): CiStatus {
  if (checks.length === 0) return 'none'
  if (checks.some((c) => c.status === 'failure')) return 'failure'
  if (checks.some((c) => c.status === 'pending')) return 'pending'
  return 'success'
}

function mapReviewState(v: unknown): PullRequestReview['state'] {
  switch (v) {
    case 'APPROVED':
      return 'approved'
    case 'CHANGES_REQUESTED':
      return 'changesRequested'
    case 'DISMISSED':
      return 'dismissed'
    case 'PENDING':
      return 'pending'
    default:
      return 'commented'
  }
}

/** Inline review comments (REST), threaded by the root comment they reply to. */
export function mapThreads(pages: readonly unknown[]): CommentThread[] {
  const comments = pages.map(obj).filter((c) => typeof c['id'] === 'number')
  const byId = new Map(comments.map((c) => [num(c['id']), c]))
  const rootOf = (c: Json): number => {
    let cur = c
    for (let i = 0; i < 50 && typeof cur['in_reply_to_id'] === 'number'; i++) {
      const parent = byId.get(num(cur['in_reply_to_id']))
      if (!parent) return num(cur['in_reply_to_id'])
      cur = parent
    }
    return num(cur['id'])
  }
  const threads = new Map<number, CommentThread>()
  for (const c of comments) {
    const root = rootOf(c)
    const rootComment = byId.get(root) ?? c
    const comment: InlineComment = {
      id: String(num(c['id'])),
      author: login(c['user']),
      isBot: isBot(c['user'], obj(c['user'])['type']),
      body: str(c['body']),
      path: str(c['path']),
      line: (typeof c['line'] === 'number' ? c['line'] : typeof c['original_line'] === 'number' ? c['original_line'] : undefined) as number | undefined,
      createdAt: epoch(c['created_at'])
    }
    const thread = threads.get(root) ?? {
      id: String(root),
      path: str(rootComment['path']),
      line: (typeof rootComment['line'] === 'number' ? rootComment['line'] : typeof rootComment['original_line'] === 'number' ? rootComment['original_line'] : undefined) as number | undefined,
      comments: []
    }
    thread.comments.push(comment)
    threads.set(root, thread)
  }
  for (const t of threads.values()) t.comments.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
  return [...threads.values()].sort((a, b) => (a.comments[0]?.createdAt ?? 0) - (b.comments[0]?.createdAt ?? 0))
}

/** `gh pr view --json …` plus the inline comments, as a detail. Throws when the view is not a PR. */
export function mapDetail(view: unknown, inlinePages: readonly unknown[], ref: PullRequestRef): PullRequestDetail {
  const v = obj(view)
  const checks: PullRequestCheck[] = arr(v['statusCheckRollup']).map((c) => ({
    name: str(c['name'] ?? c['context']) || 'check',
    status: mapCheckStatus(c),
    url: str(c['detailsUrl'] ?? c['targetUrl']) || undefined
  }))
  const commits: PullRequestCommit[] = arr(v['commits']).map((c) => {
    const author = arr(c['authors'])[0]
    return { sha: str(c['oid']), headline: str(c['messageHeadline']), author: str(author?.['login'] ?? author?.['name']), date: epoch(c['committedDate']) }
  })
  const reviews: PullRequestReview[] = arr(v['reviews']).map((r, i) => ({
    id: str(r['id']) || `review-${i}`,
    author: login(r['author']),
    isBot: isBot(r['author']),
    state: mapReviewState(r['state']),
    body: str(r['body']),
    submittedAt: epoch(r['submittedAt'])
  }))
  const comments: PullRequestComment[] = arr(v['comments']).map((c, i) => ({
    id: str(c['id']) || `comment-${i}`,
    author: login(c['author']),
    isBot: isBot(c['author']),
    body: str(c['body']),
    createdAt: epoch(c['createdAt'])
  }))
  return {
    provider: ref.provider,
    owner: ref.owner,
    repo: ref.repo,
    number: ref.number,
    url: str(v['url']) || ref.url,
    title: str(v['title']),
    author: login(v['author']),
    branch: str(v['headRefName']),
    base: str(v['baseRefName']),
    state: mapState(v['state']),
    isDraft: v['isDraft'] === true,
    reviewDecision: mapDecision(v['reviewDecision']),
    ci: combineChecks(checks),
    mergeable: mapMergeable(v['mergeable']),
    additions: num(v['additions']),
    deletions: num(v['deletions']),
    changedFiles: num(v['changedFiles']),
    updatedAt: epoch(v['updatedAt']),
    headSha: str(v['headRefOid']) || undefined,
    body: str(v['body']),
    labels: arr(v['labels']).map((l) => str(l['name'])).filter(Boolean),
    requestedReviewers: arr(v['reviewRequests']).map((r) => str(r['login'] ?? r['name'] ?? r['slug'])).filter(Boolean),
    createdAt: epoch(v['createdAt']),
    mergedAt: epoch(v['mergedAt']),
    reviews,
    comments,
    threads: mapThreads(inlinePages),
    commits,
    checks
  }
}
