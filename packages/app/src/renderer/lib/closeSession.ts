import { worktreeSettings, type Profile } from '@workhub/core'
import type { SessionView } from '@shared/api'

/**
 * Whether closing a session asks first: a working session (closing stops the turn), or one in a
 * worktree Workhub created when its profile asks what to do with the worktree on close.
 */
export function closeAsks(view: Pick<SessionView, 'worktree' | 'profileId'>, working: boolean, profiles: readonly Pick<Profile, 'id' | 'worktrees'>[]): boolean {
  return working || offersWorktreeRemoval(view, profiles)
}

/** Whether the close dialog offers to remove the session's worktree (the profile's "On close" is "Ask"). */
export function offersWorktreeRemoval(view: Pick<SessionView, 'worktree' | 'profileId'>, profiles: readonly Pick<Profile, 'id' | 'worktrees'>[]): boolean {
  if (!view.worktree) return false
  return worktreeSettings(profiles.find((p) => p.id === view.profileId)).onClose === 'ask'
}
