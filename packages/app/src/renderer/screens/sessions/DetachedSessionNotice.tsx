import { AppWindowMac, AppWindow } from 'lucide-react'
import { Button } from '../../components/atoms'
import { EmptyState } from '../../components/molecules'
import { useI18n } from '../../i18n/I18nProvider'
import { sessionTitle } from '../../lib/windows'
import type { SessionData } from '../../store'

/** What the main window shows for a session that is in its own window. */
export function DetachedSessionNotice({ data }: { data: SessionData | undefined }) {
  const { t } = useI18n()
  if (!data) return null
  const id = data.view.id
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-bg p-8" data-testid="detached-session">
      <EmptyState
        icon={<AppWindow className="size-7 text-accent" aria-hidden />}
        eyebrow={sessionTitle(data.view)}
        title={t('window.detachedTitle')}
        description={t('window.detachedBody')}
        action={
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => window.hub.windows.openSession(id)}>
              {t('window.showWindow')}
            </Button>
            <Button variant="primary" icon={<AppWindowMac className="size-4" aria-hidden />} onClick={() => window.hub.windows.dock(id)}>
              {t('window.moveToMain')}
            </Button>
          </div>
        }
      />
    </div>
  )
}
