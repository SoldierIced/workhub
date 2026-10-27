import { Bot, MessagesSquare } from 'lucide-react'
import { useState } from 'react'
import type { LinkReason } from '@workhub/core'
import type { HistoryItem } from '@shared/api'
import { useI18n } from '../../i18n/I18nProvider'
import { Badge } from '../atoms/Badge'
import { Button } from '../atoms/Button'
import { Spinner } from '../atoms/Spinner'

export interface PastSessionsProps {
  items: { entry: HistoryItem; reason?: LinkReason }[]
  loading: boolean
  error?: string
  /** Asks for the past session to be opened again. */
  onResume: (entry: HistoryItem) => void
  className?: string
}

/** Past sessions linked to a PR or ticket: Claude's can be resumed, other agents' are listed only. */
export function PastSessions({ items, loading, error, onResume, className }: PastSessionsProps) {
  const { t, formatDate } = useI18n()
  const [sent, setSent] = useState<string | null>(null)
  if (loading) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted" role="status">
        <Spinner className="size-3.5" /> {t('links.pastSessions.loading')}
      </p>
    )
  }
  if (error) return <p role="alert" className="text-sm text-danger">{t('links.pastSessions.error', { message: error })}</p>
  if (items.length === 0) return <p className="text-sm text-subtle">{t('links.pastSessions.empty')}</p>
  return (
    <ul className={className ?? 'flex flex-col divide-y divide-border rounded-lg border border-border bg-surface'} aria-label={t('links.pastSessions')}>
      {items.map(({ entry, reason }) => {
        const id = `${entry.agentId}:${entry.agentSessionId}`
        return (
          <li key={id} className="flex items-center gap-3 px-3 py-2" data-testid="past-session">
            <div className="min-w-0 flex-1">
              <div className="truncate text-base">{entry.title || t('history.untitled')}</div>
              <div className="flex flex-wrap items-center gap-2 text-xs text-subtle">
                <span>{formatDate(entry.lastModified, { dateStyle: 'medium', timeStyle: 'short' })}</span>
                <Badge icon={<Bot className="size-3" aria-hidden />} className="h-4">
                  {entry.agentName}
                </Badge>
                {reason && <Badge tone="accent" className="h-4">{t(`links.reason.${reason}`)}</Badge>}
              </div>
            </div>
            {entry.resumable ? (
              <Button
                size="sm"
                variant="secondary"
                icon={sent === id ? <Spinner className="size-3" /> : <MessagesSquare className="size-3.5" aria-hidden />}
                disabled={sent !== null}
                onClick={() => {
                  setSent(id)
                  onResume(entry)
                  window.setTimeout(() => setSent(null), 2500)
                }}
              >
                {t('links.resume')}
              </Button>
            ) : (
              <span className="text-xs text-subtle" title={t('links.listedOnly')}>
                {t('links.listedOnly')}
              </span>
            )}
          </li>
        )
      })}
    </ul>
  )
}
