import { MessagesSquare } from 'lucide-react'
import type { SlackLinkSummary } from '@workhub/core'
import { useI18n } from '../../i18n/I18nProvider'
import { cn } from '../../lib/cn'

/**
 * "Linked to Slack" (Workhub 1's SlackBadge): a Slack icon, how many threads and messages when
 * more than one, and a dot while a followed thread has replies the user has not looked at.
 * Renders nothing when Slack holds nothing about the item.
 */
export function SlackBadge({ summary, onOpen, className }: { summary: SlackLinkSummary | null; onOpen: () => void; className?: string }) {
  const { t, tn } = useI18n()
  if (!summary) return null
  const total = summary.threads + summary.messages
  const parts = [summary.threads > 0 ? tn('slack.badge.threads', summary.threads) : null, summary.messages > 0 ? tn('slack.badge.messages', summary.messages) : null, summary.unread ? t('slack.badge.unread') : null]
  const label = t('slack.badge.label', { parts: parts.filter(Boolean).join(', ') })
  return (
    <button
      type="button"
      data-testid="slack-badge"
      data-unread={summary.unread || undefined}
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation()
        onOpen()
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      className={cn(
        'relative inline-flex h-5 shrink-0 items-center gap-0.5 rounded-full px-1.5 text-2xs font-medium tabular-nums transition-colors hover:bg-surface-hover',
        summary.unread ? 'text-accent' : 'text-subtle hover:text-text',
        className
      )}
    >
      <MessagesSquare className="size-3.5" aria-hidden />
      {total > 1 && <span>{total}</span>}
      {summary.unread && <span aria-hidden className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-accent" />}
    </button>
  )
}
