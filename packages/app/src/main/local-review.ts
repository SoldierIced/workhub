/**
 * The human review of a session's local changes (Workhub 1's LocalReviewView and LocalReviewStore):
 * loads the diff of every repo the session touched, keeps the comments not sent yet (while the app
 * runs), and hands review messages to the session. A message sent while the session works is
 * queued and retried every few seconds, like the PR events and the Slack wake-ups; it is dropped
 * when the session ends or stays busy past `PENDING_TTL_MS`.
 */
import { isAbsolute, relative, resolve } from 'node:path'
import type { LocalChanges } from '@workhub/adapters/git-review'
import type { LocalReviewDelivery, LocalReviewScope, PullRequestItem, ReviewComment } from '@workhub/core'
import type { SessionView } from '../shared/api'
import type { LocalReviewLoad, LocalReviewSession } from '../shared/local-review-api'
import type { IpcRegistrar } from './ipc-guard'

export const PENDING_TTL_MS = 12 * 3600_000
export const RETRY_MS = 3_000
/** Comments kept per session; a review never needs more. */
const MAX_COMMENTS = 1_000
const MAX_MESSAGE = 200_000

export interface LocalReviewDeps {
  sessions: { list(): SessionView[] }
  /** Types the text into the session (chat or console); `waiting` while it is not idle. */
  deliver(sessionId: string, text: string): Promise<'delivered' | 'waiting'>
  changes: Pick<LocalChanges, 'load'>
  /** The user's own open pull requests for a profile, to match a repo's branch; empty when unknown. */
  myPullRequests?(profileId: string | null): Promise<PullRequestItem[]>
  emit(sessionId: string, delivery: LocalReviewDelivery): void
  now?: () => number
}

const isLive = (v: SessionView) => v.state === 'ready' || v.state === 'busy' || v.state === 'starting'

/** Whether `path` (relative to `root`) stays inside `root`. */
export function insideRoot(root: string, path: string): string | null {
  if (!path || isAbsolute(path)) return null
  const full = resolve(root, path)
  const rel = relative(root, full)
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? full : null
}

/** A comment as the renderer sent it, checked field by field; null when it is not one. */
export function validComment(c: unknown): ReviewComment | null {
  if (!c || typeof c !== 'object') return null
  const o = c as Record<string, unknown>
  const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : null)
  const id = str('id')
  const repoRoot = str('repoRoot')
  const repoName = str('repoName')
  const path = str('path')
  const text = str('text')
  if (!id || !repoRoot || repoName === null || !path || text === null) return null
  if (o['side'] !== 'old' && o['side'] !== 'new') return null
  if (typeof o['line'] !== 'number' || !Number.isInteger(o['line']) || (o['line'] as number) < 0) return null
  const createdAt = typeof o['createdAt'] === 'number' ? (o['createdAt'] as number) : 0
  return { id, repoRoot, repoName, path, side: o['side'], line: o['line'] as number, text: text.slice(0, 20_000), createdAt }
}

export class LocalReviewService {
  private readonly drafts = new Map<string, ReviewComment[]>()
  private readonly deliveries = new Map<string, LocalReviewDelivery>()
  private readonly pending = new Map<string, { message: string; queuedAt: number }>()
  /** The repo roots each session's last load returned: the only folders files are opened from. */
  private readonly roots = new Map<string, Set<string>>()
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly now: () => number

  constructor(private readonly deps: LocalReviewDeps) {
    this.now = deps.now ?? Date.now
  }

  private view(sessionId: string): SessionView | undefined {
    return this.deps.sessions.list().find((v) => v.id === sessionId)
  }

  sessionInfo(v: SessionView): LocalReviewSession {
    const blocker = v.readOnly ? 'readOnly' : !isLive(v) ? 'closed' : undefined
    return { id: v.id, label: v.label, agentName: v.agentName, cwd: v.cwd, ...(blocker ? { blocker } : {}) }
  }

  async load(sessionId: string, scope: LocalReviewScope): Promise<LocalReviewLoad> {
    const v = this.view(sessionId)
    if (!v) return { ok: false, reason: 'unknownSession' }
    const prs = (await this.deps.myPullRequests?.(v.profileId ?? null).catch(() => [])) ?? []
    try {
      const review = await this.deps.changes.load({
        folder: v.cwd,
        scope,
        since: v.startedAt,
        pullRequestOf: ({ name, remoteName, branch }) => {
          const repo = (remoteName ?? name).toLowerCase()
          const hit = prs.find((p) => p.pr.branch === branch && p.pr.repo.toLowerCase() === repo && p.pr.state === 'open')
          return hit ? { number: hit.pr.number, url: hit.pr.url, base: hit.pr.base } : undefined
        }
      })
      this.roots.set(sessionId, new Set([...(this.roots.get(sessionId) ?? []), ...review.repos.map((r) => r.root)]))
      return { ok: true, session: this.sessionInfo(v), review }
    } catch (err) {
      return { ok: false, reason: 'failed', detail: err instanceof Error ? err.message : String(err) }
    }
  }

  /** The absolute path of a file in a repo this session's review loaded; null otherwise. */
  filePath(sessionId: string, repoRoot: string, path: string): string | null {
    if (!this.roots.get(sessionId)?.has(repoRoot)) return null
    return insideRoot(repoRoot, path)
  }

  comments(sessionId: string): ReviewComment[] {
    return this.drafts.get(sessionId) ?? []
  }

  setComments(sessionId: string, comments: unknown): void {
    const list = Array.isArray(comments) ? comments.slice(0, MAX_COMMENTS).map(validComment).filter((c): c is ReviewComment => c !== null) : []
    if (list.length) this.drafts.set(sessionId, list)
    else this.drafts.delete(sessionId)
  }

  delivery(sessionId: string): LocalReviewDelivery | null {
    return this.deliveries.get(sessionId) ?? null
  }

  private record(sessionId: string, d: LocalReviewDelivery): LocalReviewDelivery {
    this.deliveries.set(sessionId, d)
    this.deps.emit(sessionId, d)
    return d
  }

  /**
   * Hands `text` to the session now, or queues it until the session is idle. A message sent while
   * another one waits joins it, so the session reads them as one.
   */
  async send(sessionId: string, text: string): Promise<LocalReviewDelivery> {
    const message = text.slice(0, MAX_MESSAGE)
    const v = this.view(sessionId)
    if (!v || !isLive(v) || v.readOnly) return this.record(sessionId, { state: 'dropped', reason: 'closed', at: this.now() })
    const waiting = this.pending.get(sessionId)
    if (waiting) {
      waiting.message += '\n\n' + message
      return this.record(sessionId, { state: 'queued', at: this.now() })
    }
    const outcome = await this.deps.deliver(sessionId, message).catch(() => 'waiting' as const)
    if (outcome === 'delivered') return this.record(sessionId, { state: 'delivered', at: this.now() })
    this.pending.set(sessionId, { message, queuedAt: this.now() })
    this.startLoop()
    return this.record(sessionId, { state: 'queued', at: this.now() })
  }

  private startLoop(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.flush(), RETRY_MS)
    this.timer.unref?.()
  }

  /** Retries every queued message; stops the loop once nothing is left. */
  async flush(): Promise<void> {
    for (const [id, waiting] of [...this.pending]) {
      const v = this.view(id)
      if (!v || !isLive(v)) {
        this.pending.delete(id)
        this.record(id, { state: 'dropped', reason: 'closed', at: this.now() })
        continue
      }
      if (this.now() - waiting.queuedAt > PENDING_TTL_MS) {
        this.pending.delete(id)
        this.record(id, { state: 'dropped', reason: 'busy', at: this.now() })
        continue
      }
      const outcome = await this.deps.deliver(id, waiting.message).catch(() => 'waiting' as const)
      if (outcome === 'delivered' && this.pending.get(id) === waiting) {
        this.pending.delete(id)
        this.record(id, { state: 'delivered', at: this.now() })
      }
    }
    if (!this.pending.size) this.stop()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}

export interface LocalReviewIpcDeps {
  openWindow(sessionId: string): void
  openPath(path: string): Promise<string>
}

export function registerLocalReviewIpc(ipc: IpcRegistrar, service: LocalReviewService, deps: LocalReviewIpcDeps): void {
  const scopeOf = (s: unknown): LocalReviewScope => (s === 'uncommitted' ? 'uncommitted' : 'branch')
  ipc.handle('localReview:load', (_e, sessionId: string, scope: unknown) => service.load(String(sessionId), scopeOf(scope)))
  ipc.handle('localReview:comments', (_e, sessionId: string) => service.comments(String(sessionId)))
  ipc.handle('localReview:setComments', (_e, sessionId: string, comments: unknown) => service.setComments(String(sessionId), comments))
  ipc.handle('localReview:send', (_e, sessionId: string, text: unknown) => service.send(String(sessionId), String(text ?? '')))
  ipc.handle('localReview:delivery', (_e, sessionId: string) => service.delivery(String(sessionId)))
  ipc.handle('localReview:openWindow', (_e, sessionId: string) => deps.openWindow(String(sessionId)))
  ipc.handle('localReview:filePath', (_e, sessionId: string, repoRoot: string, path: string) => service.filePath(String(sessionId), String(repoRoot), String(path)))
  ipc.handle('localReview:openFile', async (_e, sessionId: string, repoRoot: string, path: string) => {
    const full = service.filePath(String(sessionId), String(repoRoot), String(path))
    if (!full) return false
    return (await deps.openPath(full)) === ''
  })
}
