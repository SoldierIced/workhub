import type { BackgroundTaskSummary } from '@workhub/core'

const NONE: BackgroundTaskSummary[] = []

/**
 * The background tasks a session shows as "waiting on": commands, watchers and workflows, oldest
 * first. Sub-agents are left out: the sidebar already lists them under the row.
 */
export function waitingTasks(tasks: readonly BackgroundTaskSummary[] | undefined): BackgroundTaskSummary[] {
  if (!tasks?.length) return NONE
  const shown = tasks.filter((t) => t.kind !== 'agent')
  return shown.length ? shown.sort((a, b) => a.since - b.since) : NONE
}
