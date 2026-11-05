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

export interface SessionCloseDeps {
  /** The profiles as configured (read when the window has not loaded the config yet). */
  profiles: () => Promise<readonly Pick<Profile, 'id' | 'worktrees'>[]>
  /** Shows the close dialog (confirm a working session, keep or remove its worktree). */
  ask: () => void
  close: () => Promise<unknown>
  fail: (e: unknown) => void
}

/**
 * Closing a session from a shortcut or a menu, the same in every window: ask first when
 * `closeAsks` says so, else close at once. Profiles that cannot be read count as none.
 */
export async function requestSessionClose(view: Pick<SessionView, 'worktree' | 'profileId'>, working: boolean, deps: SessionCloseDeps): Promise<void> {
  const profiles = await deps.profiles().catch(() => [])
  if (closeAsks(view, working, profiles)) return deps.ask()
  await deps.close().catch(deps.fail)
}
