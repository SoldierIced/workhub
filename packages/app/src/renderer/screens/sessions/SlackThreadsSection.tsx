import { Hash, Settings } from 'lucide-react'
import { plainText, sessionIdentity, sessionSlackMessages, sessionSlackThreads, threadArchiveMinutes, type ChatMessage } from '@workhub/core'
import type { SessionView } from '@shared/api'
import { useSlack } from '../../chatStore'
import { Button } from '../../components/atoms'
import { useConfig } from '../../configStore'
import { useI18n } from '../../i18n/I18nProvider'
import { relativeTime } from '../../lib/pullRequests'
import { slackSetupHint, type SlackSetupHint } from '../../lib/slackLinks'
import { ThreadGroup } from '../slack/ThreadList'
import { MonitorSection } from './MonitorSection'

/** The Settings tab that fixes each hint. */
const HINT_TAB: Record<SlackSetupHint, string> = { module: 'profiles', watcher: 'slack', channels: 'slack' }

/**
 * The monitor's Slack section (Workhub 1's session Slack section): the threads this session owns,
 * then the open ones about its pull requests or tickets (quiet ones fold into "Archived (n)"), then
 * the latest messages of the watched channels that link its PRs or name its tickets. Everything
 * comes from what the watcher already read: nothing here calls Slack. When the watcher cannot
 * read, a hint says what to turn on instead of leaving the section out.
 */
export function SlackThreadsSection({ view, prUrls = [], ticketKeys = [] }: { view: SessionView; prUrls?: readonly string[]; ticketKeys?: readonly string[] }) {
  const { t } = useI18n()
  const snap = useSlack()
  const config = useConfig()
  if (!snap) return null
  const identity = sessionIdentity(view)
  const threads = sessionSlackThreads(snap.threads, identity, prUrls, ticketKeys)
  const messages = sessionSlackMessages(snap.messages, prUrls, ticketKeys)
  const profile = config?.config.profiles.find((p) => p.id === (view.profileId ?? config.config.activeProfileId))
  const hint = slackSetupHint(profile, snap.settings)
  const channelName = (id: string) => snap.settings.channels.find((c) => c.id === id)?.name || id
  const count = threads.length + messages.length
  return (
    <div data-testid="monitor-slack-threads">
      <MonitorSection id="slack" title={t('slack.monitor.title')} count={count || undefined}>
        {/* Its own scroll past a fixed height, like the monitor's other lists. */}
        <div className="-mr-1.5 flex max-h-96 flex-col gap-3 overflow-y-auto overscroll-contain pr-1.5" data-monitor-scroll="slack">
          {threads.length > 0 && (
            <ThreadGroup threads={threads} me={snap.me} archiveMinutes={threadArchiveMinutes(profile)} now={Date.now()} actions={{ compact: true, channelName }} />
          )}
          {messages.length > 0 && (
            <div className="flex flex-col gap-1" data-testid="monitor-slack-messages">
              <h3 className="text-2xs font-semibold text-muted">{t('slack.monitor.messages')}</h3>
              <ul className="flex flex-col divide-y divide-border">
                {messages.map((m) => (
                  <SessionMessage key={`${m.channelId}:${m.ts}`} message={m} channel={channelName(m.channelId)} />
                ))}
              </ul>
            </div>
          )}
          {hint ? (
            <div className="flex flex-col items-start gap-1.5" data-testid="monitor-slack-hint">
              <p className="text-xs text-muted">{t(`slack.monitor.hint.${hint}`)}</p>
              <Button size="sm" variant="ghost" icon={<Settings className="size-3.5" aria-hidden />} onClick={() => window.hub.setup.openSettings(HINT_TAB[hint])}>
                {t('slack.monitor.openSettings')}
              </Button>
            </div>
          ) : (
            count === 0 && <p className="text-xs text-subtle">{t('slack.monitor.empty')}</p>
          )}
        </div>
      </MonitorSection>
    </div>
  )
}

/** One channel message about the session: author, channel, when, its text, opening in Slack. */
function SessionMessage({ message: m, channel }: { message: ChatMessage; channel: string }) {
  const { t, locale } = useI18n()
  return (
    <li className="flex flex-col gap-0.5 py-1.5" data-testid="monitor-slack-message">
      <div className="flex min-w-0 items-center gap-1.5 text-xs">
        <span className="truncate font-semibold">{m.user}</span>
        <span className="inline-flex shrink-0 items-center gap-0.5 text-muted">
          <Hash className="size-3" aria-hidden />
          {channel}
        </span>
        <span className="shrink-0 text-subtle">{relativeTime(Number(m.ts) * 1000, Date.now(), locale)}</span>
        {m.permalink && (
          <button type="button" className="ml-auto shrink-0 text-2xs text-accent hover:underline" onClick={() => window.hub.openExternal(m.permalink!)}>
            {t('slack.openInSlack')}
          </button>
        )}
      </div>
      <p className="line-clamp-3 text-xs break-words whitespace-pre-wrap select-text" title={plainText(m.text)}>
        {plainText(m.text)}
      </p>
    </li>
  )
}
