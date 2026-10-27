import type { Profile } from '../domain/profile'
import { tsToMs } from './links'
import { lastActivity } from './threads'
import type { TrackedThread } from './types'

/** Default of a profile's "archive Slack threads after N minutes without activity". */
export const DEFAULT_THREAD_ARCHIVE_MINUTES = 15
export const MIN_THREAD_ARCHIVE_MINUTES = 1

/** The profile's archive threshold in minutes (the default when unset). */
export function threadArchiveMinutes(profile: Pick<Profile, 'slackArchiveMinutes'> | undefined): number {
  const value = profile?.slackArchiveMinutes
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(MIN_THREAD_ARCHIVE_MINUTES, Math.floor(value)) : DEFAULT_THREAD_ARCHIVE_MINUTES
}

/** The last activity of a thread, either side: its root, a reply, a message the owner sent. */
export function threadActivity(t: TrackedThread): number {
  return Math.max(lastActivity(t), tsToMs(t.ts), ...t.sentTs.map(tsToMs))
}

/**
 * The threads shown as archived: quiet for longer than `minutes`, and not the most recent thread
 * of a session that follows more than one. A view state only: archived threads stay watched and
 * keep waking their session, and a new reply brings them back at once (it is new activity).
 */
export function archivedThreadIds(threads: readonly TrackedThread[], now: number, minutes: number): Set<string> {
  const limit = Math.max(MIN_THREAD_ARCHIVE_MINUTES, minutes) * 60_000
  const byOwner = new Map<string, TrackedThread[]>()
  for (const t of threads) if (t.owner) byOwner.set(t.owner, [...(byOwner.get(t.owner) ?? []), t])
  const archived = new Set<string>()
  for (const owned of byOwner.values()) {
    if (owned.length < 2) continue
    const newest = owned.reduce((a, b) => (threadActivity(b) > threadActivity(a) ? b : a))
    for (const t of owned) if (t !== newest && now - threadActivity(t) > limit) archived.add(t.id)
  }
  return archived
}
