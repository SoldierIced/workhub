import { FileCode2, FilePen, FilePlus, FileText, FolderOpen, GitCompareArrows } from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import { useEffect, useMemo, useState } from 'react'
import type { LocalReviewDelivery, SessionFile } from '@workhub/core'
import { Badge, Button } from '../../components/atoms'
import { useI18n } from '../../i18n/I18nProvider'
import { fileName, folderLabel, sessionFiles } from '../../lib/localReview'
import type { SessionData } from '../../store'

const VERB_ICON = { edited: FilePen, wrote: FilePlus, read: FileText } as const

/** The last review message's fate for a session, kept current by the main process. */
function useDelivery(sessionId: string): LocalReviewDelivery | null {
  const [delivery, setDelivery] = useState<LocalReviewDelivery | null>(null)
  useEffect(() => {
    let alive = true
    void window.hub.localReview.delivery(sessionId).then((d) => alive && setDelivery(d))
    const off = window.hub.localReview.onDelivery((id, d) => id === sessionId && setDelivery(d))
    return () => {
      alive = false
      off()
    }
  }, [sessionId])
  return delivery
}

/** "Review changes": the session's local diff in its own window, with the state of the last review message. */
export function LocalReviewButton({ sessionId, compact }: { sessionId: string; compact?: boolean }) {
  const { t, formatDate } = useI18n()
  const delivery = useDelivery(sessionId)
  const status =
    delivery?.state === 'queued'
      ? t('localReview.delivery.queued')
      : delivery?.state === 'dropped'
        ? t(delivery.reason === 'busy' ? 'localReview.delivery.dropped.busy' : 'localReview.delivery.dropped.closed')
        : delivery?.state === 'delivered'
          ? t('localReview.delivery.delivered', { time: formatDate(delivery.at, { hour: '2-digit', minute: '2-digit' }) })
          : null
  return (
    <span className="inline-flex items-center gap-1">
      <Button
        size="sm"
        variant="ghost"
        icon={<GitCompareArrows className="size-3.5" aria-hidden />}
        title={status ? `${t('localReview.buttonHint')}\n${status}` : t('localReview.buttonHint')}
        onClick={() => void window.hub.localReview.openWindow(sessionId)}
        data-testid="local-review-button"
        aria-label={compact ? t('localReview.button') : undefined}
        className={compact ? 'px-1.5' : undefined}
      >
        {!compact && t('localReview.button')}
      </Button>
      {delivery && delivery.state !== 'delivered' && (
        <Badge tone={delivery.state === 'queued' ? 'info' : 'warning'} title={status ?? undefined} data-testid="local-review-delivery">
          {delivery.state === 'queued' ? '…' : '!'}
        </Badge>
      )}
    </span>
  )
}

function FileRow({ file, cwd }: { file: SessionFile; cwd: string }) {
  const { t, formatDate } = useI18n()
  const Icon = VERB_ICON[file.kind]
  return (
    <DropdownMenu.Item
      onSelect={() => void window.hub.files.openWindow(file.path, cwd)}
      title={file.path}
      className="flex cursor-default select-none items-center gap-2.5 rounded-sm px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent-soft"
    >
      <Icon className="size-4 shrink-0 text-subtle" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{fileName(file.path)}</span>
        <span className="block truncate font-mono text-xs text-subtle">{folderLabel(file.path, cwd)}</span>
      </span>
      <span className="shrink-0 text-right text-xs text-muted">
        {t(`files.verb.${file.kind}`)}
        {file.at !== undefined && <span className="block text-subtle">{formatDate(file.at, { hour: '2-digit', minute: '2-digit' })}</span>}
      </span>
    </DropdownMenu.Item>
  )
}

/** "Files": every file the agent edited, wrote or read in this session, each opening in the file viewer. Hidden until there is one. */
export function SessionFilesMenu({ data, compact }: { data: SessionData; compact?: boolean }) {
  const { t } = useI18n()
  const files = useMemo(() => sessionFiles(data.items), [data.items])
  if (!files.length) return null
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button
          size="sm"
          variant="ghost"
          icon={<FolderOpen className="size-3.5" aria-hidden />}
          title={t('files.buttonHint')}
          data-testid="session-files"
          aria-label={compact ? t('files.button') : undefined}
          className={compact ? 'px-1.5' : undefined}
        >
          {!compact && t('files.button')}
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={6} className="z-50 max-h-96 w-[26rem] animate-fade-in overflow-y-auto rounded-md border border-border bg-surface-raised p-1 shadow-lg">
          <DropdownMenu.Label className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-subtle">
            <FileCode2 className="size-3.5" aria-hidden />
            {t('files.buttonHint')}
          </DropdownMenu.Label>
          {files.map((f) => (
            <FileRow key={f.path} file={f} cwd={data.view.cwd} />
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

/** The session header's review entry points: the local review and the Files list (`compact`: icons only, the name on hover). */
export function SessionReviewTools({ data, compact }: { data: SessionData; compact?: boolean }) {
  if (data.view.readOnly) return null
  return (
    <>
      <SessionFilesMenu data={data} compact={compact} />
      <LocalReviewButton sessionId={data.view.id} compact={compact} />
    </>
  )
}
