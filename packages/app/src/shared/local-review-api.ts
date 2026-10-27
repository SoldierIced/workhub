// Types of the local review and file viewer bridges (window.hub.localReview, window.hub.files), shared by main, preload and renderer.
import type { LocalReview, LocalReviewDelivery, LocalReviewScope, ReviewComment } from '@workhub/core'

/** The session a review belongs to, as the review window shows it. */
export interface LocalReviewSession {
  id: string
  label: string
  agentName: string
  cwd: string
  /** Why comments cannot reach the session (closed, read-only reviewer); absent when they can. */
  blocker?: 'closed' | 'readOnly'
}

export type LocalReviewLoad = { ok: true; session: LocalReviewSession; review: LocalReview } | { ok: false; reason: 'unknownSession' | 'failed'; detail?: string }

export interface LocalReviewApi {
  /** The session's local changes in `scope` (its folder's repo and the repos inside it it touched). */
  load(sessionId: string, scope: LocalReviewScope): Promise<LocalReviewLoad>
  /** The comments not sent yet (kept while the app runs). */
  comments(sessionId: string): Promise<ReviewComment[]>
  setComments(sessionId: string, comments: ReviewComment[]): Promise<void>
  /** Sends a message to the session now, or queues it until the session is idle. */
  send(sessionId: string, text: string): Promise<LocalReviewDelivery>
  delivery(sessionId: string): Promise<LocalReviewDelivery | null>
  onDelivery(cb: (sessionId: string, delivery: LocalReviewDelivery) => void): () => void
  /** The review in its own window (one per session; an open one is focused). */
  openWindow(sessionId: string): Promise<void>
  /** Opens a file of a reviewed repo in its default app; false when it is not there. */
  openFile(sessionId: string, repoRoot: string, path: string): Promise<boolean>
  /** The absolute path of a file of a reviewed repo, for the file viewer; null when it is not one. */
  filePath(sessionId: string, repoRoot: string, path: string): Promise<string | null>
}

/** Size and modification time: enough to tell that a file changed on disk. */
export interface FileStamp {
  size: number
  mtimeMs: number
}

export type FileContent =
  | { kind: 'missing' }
  | { kind: 'folder' }
  | { kind: 'unreadable'; reason?: string }
  | { kind: 'binary'; size: number }
  | { kind: 'text'; text: string; lineCount: number; truncated: boolean; size: number }
  /** An image or PDF, as bytes the page turns into a blob URL. */
  | { kind: 'image' | 'pdf'; mime: string; bytes: Uint8Array; size: number }

export interface FileRead {
  stamp: FileStamp | null
  content: FileContent
}

export interface FilesApi {
  /** A file in the viewer window; a relative path is taken from `cwd` (the session's folder). */
  openWindow(path: string, cwd?: string): Promise<void>
  /**
   * Writes pasted images (`data:` URLs) to files of their own in the data folder, once each (named
   * after their content), for `openWindow`. Each entry is the file, or null when it was not an image.
   */
  cacheImages(dataUrls: string[]): Promise<(string | null)[]>
  /**
   * Only from a viewer window, for its own file: the content, or null when it did not change since
   * `known.stamp`. `forceText` reads an image as text (an SVG the page cannot draw).
   */
  read(path: string, known?: { stamp: FileStamp | null } | null, forceText?: boolean): Promise<FileRead | null>
  copyPath(path: string): void
  reveal(path: string): Promise<void>
  openDefault(path: string): Promise<void>
}
