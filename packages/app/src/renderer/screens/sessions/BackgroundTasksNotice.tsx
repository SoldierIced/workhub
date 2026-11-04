import { Timer } from 'lucide-react'
import type { BackgroundTaskSummary } from '@workhub/core'
import { useI18n } from '../../i18n/I18nProvider'
import { shortDuration } from '../../lib/subagentView'

/** At most this many tasks are named; the rest are counted. */
const SHOWN = 3

/**
 * The composer's line while the agent waits on work it left running (a command in the background,
 * a watcher): what each one does and for how long it has run. It only informs.
 */
export function BackgroundTasksNotice({ tasks, now }: { tasks: readonly BackgroundTaskSummary[]; now: number }) {
  const { t, tn } = useI18n()
  if (tasks.length === 0) return null
  const rest = tasks.length - SHOWN
  return (
    <div role="status" data-testid="background-tasks-notice" className="mx-3 mt-3 flex items-start gap-x-3 rounded-md bg-surface-hover px-3 py-2 text-sm text-muted">
      <Timer className="mt-0.5 size-4 shrink-0 animate-pulse" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="font-medium text-text">{tn('backgroundTasks.title', tasks.length)}</div>
        <ul className="mt-0.5 space-y-0.5">
          {tasks.slice(0, SHOWN).map((task) => (
            <li key={task.id} className="flex min-w-0 gap-1.5" data-testid="background-task">
              <span className="shrink-0 text-subtle">{t(`backgroundTasks.kind.${task.kind === 'agent' || task.kind === 'other' ? 'task' : task.kind}`)}</span>
              <span className="min-w-0 flex-1 truncate">{task.description || t('backgroundTasks.untitled')}</span>
              <span className="shrink-0 tabular-nums text-subtle">{shortDuration(now - task.since)}</span>
            </li>
          ))}
        </ul>
        {rest > 0 && <div className="text-xs text-subtle">{tn('backgroundTasks.more', rest)}</div>}
      </div>
    </div>
  )
}
