import { ChevronRight } from 'lucide-react'
import { sessionIdentity, threadArchiveMinutes } from '@workhub/core'
import type { SessionView } from '@shared/api'
import { useSlack } from '../../chatStore'
import { useConfig } from '../../configStore'
import { useI18n } from '../../i18n/I18nProvider'
import { ThreadGroup } from '../slack/ThreadList'

/** The monitor's "Slack threads": the threads this session owns; quiet ones fold into "Archived (n)". */
export function SlackThreadsSection({ view }: { view: SessionView }) {
  const { t } = useI18n()
  const snap = useSlack()
  const config = useConfig()
  const identity = sessionIdentity(view)
  const threads = snap?.threads.filter((th) => th.owner === identity) ?? []
  if (!snap || !threads.length) return null
  const profile = config?.config.profiles.find((p) => p.id === (view.profileId ?? config.config.activeProfileId))
  return (
    <details open className="group mt-4 border-t border-border pt-3" data-testid="monitor-slack-threads">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-sm text-muted select-none hover:text-text">
        <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" aria-hidden />
        {t('slack.monitor.title')}
        <span className="ml-auto text-xs text-subtle tabular-nums">{threads.length}</span>
      </summary>
      <div className="mt-2">
        <ThreadGroup threads={threads} me={snap.me} archiveMinutes={threadArchiveMinutes(profile)} now={Date.now()} actions={{ compact: true }} />
      </div>
    </details>
  )
}
