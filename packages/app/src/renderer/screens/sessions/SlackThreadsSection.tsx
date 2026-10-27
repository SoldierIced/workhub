import { sessionIdentity, threadArchiveMinutes } from '@workhub/core'
import type { SessionView } from '@shared/api'
import { useSlack } from '../../chatStore'
import { useConfig } from '../../configStore'
import { useI18n } from '../../i18n/I18nProvider'
import { ThreadGroup } from '../slack/ThreadList'
import { MonitorSection } from './MonitorSection'

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
    <div data-testid="monitor-slack-threads">
      <MonitorSection id="slack" title={t('slack.monitor.title')} count={threads.length}>
        <ThreadGroup threads={threads} me={snap.me} archiveMinutes={threadArchiveMinutes(profile)} now={Date.now()} actions={{ compact: true, channelName: (id) => snap.settings.channels.find((c) => c.id === id)?.name ?? id }} />
      </MonitorSection>
    </div>
  )
}
