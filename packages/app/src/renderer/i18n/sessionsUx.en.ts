/** English copy of closing sessions from the sidebar and of a view switch that waits for the turn. */
export const sessionsUxEn = {
  'sessions.close': 'Close session',
  'sessions.closeNamed': 'Close {name}',
  'sessions.closeTitle': 'Close {name}?',
  'sessions.closeBody': 'It is working right now: closing stops the turn in progress. The conversation stays in History.',
  'sessions.closeConfirm': 'Stop and close',
  'sessions.closeFailed': 'Could not close the session: {message}',
  'sessions.worktreeBody': 'It runs in its own worktree on {branch} ({path}). Keep it to come back to the branch, or remove the folder; the branch stays either way.',
  'sessions.worktreeKeep': 'Close, keep worktree',
  'sessions.worktreeRemove': 'Close and remove worktree',
  'sessions.worktreeDirty': 'The worktree has uncommitted changes.',
  'sessions.worktreeUnpushed.one': 'Its branch has {count} commit no remote has.',
  'sessions.worktreeUnpushed.other': 'Its branch has {count} commits no remote has.',
  'sessions.worktreeRemoveAnyway': 'Removing it loses them for good.',
  'sessions.worktreeRemoveForce': 'Remove anyway',
  'session.pendingSwitch': 'Switches to {mode} when the turn ends.',
  'session.pendingSwitchHint': 'Answer any question here; the switch follows the end of the turn.',
  'session.switchNow': 'Switch now',
  'session.switchNowHint': 'Stop the turn in progress and switch right away',
  'session.switchCancel': 'Cancel',
  'session.switchCancelHint': 'Stay in this view',
  'session.switchPending': '{mode} (waiting for the turn)'
} as const
