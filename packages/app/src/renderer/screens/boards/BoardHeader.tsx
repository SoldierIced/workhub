import { boardLiveness, type StoredBoard } from '@workhub/core'
import { Badge, StateDot } from '../../components/atoms'
import { useI18n } from '../../i18n/I18nProvider'
import type { MessageKey } from '../../i18n/translate'
import { boardTimeOptions, LIVENESS_TONE } from '../../lib/boards'

const STATUS_LABEL: Record<ReturnType<typeof boardLiveness>, MessageKey> = {
  live: 'boards.status.live',
  silent: 'boards.status.silent',
  paused: 'boards.status.paused',
  finished: 'boards.status.finished',
  failed: 'boards.status.failed'
}

/** The board's title and subtitle, its status badge and when it last arrived. */
export function BoardHeader({ stored, now }: { stored: StoredBoard; now: number }) {
  const { t, formatDate } = useI18n()
  const liveness = boardLiveness(stored, now)
  const since = formatDate(stored.receivedAt, boardTimeOptions(stored.receivedAt, now))
  return (
    <div className="flex flex-col gap-1" data-testid="board-header">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="min-w-0 break-words text-xl font-semibold tracking-tight [overflow-wrap:anywhere]">{stored.board.title}</h2>
        <Badge tone={LIVENESS_TONE[liveness]} icon={liveness === 'live' ? <StateDot tone="info" pulse /> : undefined} data-testid="board-status">
          {t(STATUS_LABEL[liveness], { time: since })}
        </Badge>
        {/* "No news since" already says when it last arrived. */}
        {liveness !== 'silent' && <span className="text-sm text-muted">{t('boards.updated', { time: since })}</span>}
      </div>
      {stored.board.subtitle && <p className="break-words text-base text-muted [overflow-wrap:anywhere]">{stored.board.subtitle}</p>}
    </div>
  )
}
