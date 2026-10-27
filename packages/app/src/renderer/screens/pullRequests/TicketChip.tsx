import { AppWindow, ExternalLink, Link, Ticket } from 'lucide-react'
import { HoverCard } from 'radix-ui'
import { useState } from 'react'
import { Badge, Button, Spinner } from '../../components/atoms'
import { useToast } from '../../components/molecules'
import { useI18n } from '../../i18n/I18nProvider'
import { cn } from '../../lib/cn'
import { CATEGORY_TONE } from '../../lib/tickets'
import { ticketPreviews, type TicketPreview } from '../../lib/ticketPreview'

/**
 * A ticket key on a pull request (Workhub 1's PRTicketChips). Clicking opens the ticket's window;
 * hovering shows its title and status, read from the tracker on demand, with "Open in the
 * browser" and "Copy link". Without a profile there is no tracker to ask: just the key.
 */
export function TicketChip({ profileId, ticketKey, className }: { profileId: string | null; ticketKey: string; className?: string }) {
  const { t } = useI18n()
  const notify = useToast()
  const [preview, setPreview] = useState<TicketPreview | undefined>(() => (profileId ? ticketPreviews().peek(profileId, ticketKey) : undefined))
  const chip = cn('inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-accent-soft px-2 font-mono text-xs font-medium text-accent', className)
  if (!profileId) {
    return (
      <span className={chip}>
        <Ticket className="size-3" aria-hidden />
        {ticketKey}
      </span>
    )
  }
  const load = (open: boolean) => {
    if (open) void ticketPreviews().load(profileId, ticketKey).then(setPreview)
  }
  const url = preview?.state === 'ready' ? preview.detail.url : undefined
  return (
    <HoverCard.Root openDelay={250} closeDelay={120} onOpenChange={load}>
      <HoverCard.Trigger asChild>
        <button
          type="button"
          data-testid="ticket-chip"
          title={t('ticket.chip.openHint', { key: ticketKey })}
          onClick={(e) => {
            e.stopPropagation()
            void window.hub.tickets.openWindow(profileId, ticketKey)
          }}
          onDoubleClick={(e) => e.stopPropagation()}
          className={cn(chip, 'hover:underline')}
        >
          <Ticket className="size-3" aria-hidden />
          {ticketKey}
        </button>
      </HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content
          side="bottom"
          align="start"
          sideOffset={6}
          className="z-50 w-80 animate-fade-in rounded-lg border border-border bg-surface-raised p-3 text-base shadow-lg"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm font-semibold text-accent">{ticketKey}</span>
            {preview?.state === 'ready' && <Badge tone={CATEGORY_TONE[preview.detail.category]}>{preview.detail.status}</Badge>}
            {preview?.state === 'ready' && preview.detail.type && <Badge>{preview.detail.type}</Badge>}
          </div>
          {!preview && (
            <p className="mt-2 flex items-center gap-2 text-sm text-muted" role="status">
              <Spinner className="size-3.5" /> {t('ticket.chip.loading', { key: ticketKey })}
            </p>
          )}
          {preview?.state === 'ready' && (
            <>
              <p className="mt-1.5 line-clamp-3 font-medium">{preview.detail.title}</p>
              {preview.detail.assignee && <p className="mt-1 text-sm text-muted">{preview.detail.assignee}</p>}
            </>
          )}
          {preview?.state === 'missing' && <p className="mt-2 text-sm text-muted">{t('ticket.chip.missing', { key: ticketKey })}</p>}
          {preview?.state === 'error' && (
            <p className="mt-2 text-sm text-danger" role="alert" title={preview.message}>
              {t('ticket.chip.error', { key: ticketKey })}
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-1.5 border-t border-border pt-2.5">
            <Button size="sm" variant="secondary" icon={<AppWindow className="size-3.5" aria-hidden />} onClick={() => void window.hub.tickets.openWindow(profileId, ticketKey)}>
              {t('ticket.chip.open')}
            </Button>
            {url && (
              <>
                <Button size="sm" variant="ghost" icon={<ExternalLink className="size-3.5" aria-hidden />} onClick={() => void window.hub.tickets.openExternal(url)}>
                  {t('tickets.openInBrowser')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Link className="size-3.5" aria-hidden />}
                  onClick={() => void navigator.clipboard.writeText(url).then(() => notify(t('ticket.linkCopied')))}
                >
                  {t('ticket.copyLink')}
                </Button>
              </>
            )}
          </div>
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  )
}
