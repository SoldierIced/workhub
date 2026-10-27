import { X } from 'lucide-react'
import { Dialog as RDialog } from 'radix-ui'
import type { ConfigSnapshot } from '@shared/api'
import { useI18n } from '../i18n/I18nProvider'
import { SettingsScreen } from './SettingsScreen'

export interface SettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  snap: ConfigSnapshot | null
  tab: string
  onTabChange: (tab: string) => void
}

/**
 * Settings as a modal over the current screen: the title, banners and tab bar stay pinned while the
 * tab's content scrolls inside the modal. Esc, the close button or a click outside dismiss it.
 */
export function SettingsDialog({ open, onOpenChange, snap, tab, onTabChange }: SettingsDialogProps) {
  const { t } = useI18n()
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-40 animate-fade-in bg-black/40 backdrop-blur-[2px]" />
        <RDialog.Content
          data-testid="settings-dialog"
          aria-describedby={undefined}
          className="fixed top-1/2 left-1/2 z-50 flex h-[min(860px,calc(100vh-48px))] w-[min(1040px,calc(100vw-48px))] -translate-x-1/2 -translate-y-1/2 animate-pop-in flex-col overflow-hidden rounded-xl border border-border bg-bg shadow-lg focus-visible:outline-none"
        >
          {/* The scrolling parent of the pinned header: only the tab content moves. */}
          <div className="min-h-0 flex-1 overflow-y-auto">
            <SettingsScreen
              snap={snap}
              tab={tab}
              onTabChange={onTabChange}
              heading={
                <div className="flex items-start gap-3">
                  <RDialog.Title className="min-w-0 flex-1 text-2xl font-semibold tracking-tight">{t('nav.settings')}</RDialog.Title>
                  <RDialog.Close aria-label={t('common.close')} className="rounded-md p-1.5 text-muted hover:bg-surface-hover hover:text-text">
                    <X className="size-5" aria-hidden />
                  </RDialog.Close>
                </div>
              }
            />
          </div>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  )
}
