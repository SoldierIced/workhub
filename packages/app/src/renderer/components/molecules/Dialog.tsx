import { X } from 'lucide-react'
import { Dialog as RDialog } from 'radix-ui'
import type { ReactNode } from 'react'
import { useI18n } from '../../i18n/I18nProvider'
import { cn } from '../../lib/cn'

export interface DialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  children: ReactNode
  footer?: ReactNode
  className?: string
  /** Where focus goes when the dialog closes; the handler may call `preventDefault` and focus something itself. */
  onCloseAutoFocus?: (event: Event) => void
}

export function Dialog({ open, onOpenChange, title, description, children, footer, className, onCloseAutoFocus }: DialogProps) {
  const { t } = useI18n()
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        {/* On the dialog's own layer: a dialog opened from another (a confirmation over Settings) dims the one below. */}
        <RDialog.Overlay className="fixed inset-0 z-50 animate-fade-in bg-black/40 backdrop-blur-[2px]" />
        <RDialog.Content
          onCloseAutoFocus={onCloseAutoFocus}
          className={cn(
            'fixed top-1/2 left-1/2 z-50 w-[min(520px,calc(100vw-48px))] -translate-x-1/2 -translate-y-1/2 animate-pop-in',
            'rounded-xl border border-border bg-surface-raised shadow-lg focus-visible:outline-none',
            className
          )}
        >
          <div className="flex items-start gap-3 px-5 pt-5">
            <div className="min-w-0 flex-1">
              <RDialog.Title className="text-lg font-semibold">{title}</RDialog.Title>
              {description ? (
                <RDialog.Description className="mt-1 text-base text-muted">{description}</RDialog.Description>
              ) : (
                <RDialog.Description className="sr-only">{title}</RDialog.Description>
              )}
            </div>
            <RDialog.Close aria-label={t('common.close')} className="rounded-md p-1 text-muted hover:bg-surface-hover hover:text-text">
              <X className="size-4" aria-hidden />
            </RDialog.Close>
          </div>
          {/* A confirmation says it all in its title and description: no empty body before the buttons. */}
          {children ? <div className="px-5 py-4">{children}</div> : <div className="h-4" />}
          {footer && <div className="flex justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  )
}
