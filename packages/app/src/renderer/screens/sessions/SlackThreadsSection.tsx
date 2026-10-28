import { sessionIdentity, sessionSlackThreads, threadArchiveMinutes } from '@workhub/core'
import type { SessionView } from '@shared/api'
import { useSlack } from '../../chatStore'
import { useConfig } from '../../configStore'
import { useI18n } from '../../i18n/I18nProvider'
import { ThreadGroup } from '../slack/ThreadList'
import { MonitorSection } from './MonitorSection'

/**
 * The monitor's "Slack threads": the threads this session owns, then the open ones about its pull
 * requests or tickets (Workhub 1's session Slack section); quiet ones fold into "Archived (n)".
 */
export function SlackThreadsSection({ view, prUrls = [], ticketKeys = [] }: { view: SessionView; prUrls?: readonly string[]; ticketKeys?: readonly string[] }) {
  const { t } = useI18n()
  const snap = useSlack()
  const config = useConfig()
  const identity = sessionIdentity(view)
  const threads = snap ? sessionSlackThreads(snap.threads, identity, prUrls, ticketKeys) : []
  if (!snap || !threads.length) return null
  const profile = config?.config.profiles.find((p) => p.id === (view.profileId ?? config.config.activeProfileId))
  return (
    <div data-testid="monitor-slack-threads">
      <MonitorSection id="slack" title={t('slack.monitor.title')} count={threads.length}>
        {/* Its own scroll past a fixed height, like the monitor's other lists. */}
        <div className="-mr-1.5 max-h-96 overflow-y-auto overscroll-contain pr-1.5" data-monitor-scroll="slack">
          <ThreadGroup threads={threads} me={snap.me} archiveMinutes={threadArchiveMinutes(profile)} now={Date.now()} actions={{ compact: true, channelName: (id) => snap.settings.channels.find((c) => c.id === id)?.name ?? id }} />
        </div>
      </MonitorSection>
    </div>
  )
}
