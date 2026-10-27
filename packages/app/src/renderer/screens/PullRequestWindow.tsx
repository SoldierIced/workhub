import { useEffect } from 'react'
import { TooltipProvider } from '../components/atoms'
import { ToastProvider } from '../components/molecules'
import { I18nProvider, useI18n } from '../i18n/I18nProvider'
import { cn } from '../lib/cn'
import { usePlatform } from '../lib/platform'
import { PullRequestDetail } from './pullRequests/PullRequestDetail'

function Frame({ profileId, url }: { profileId: string | null; url: string }) {
  const { t } = useI18n()
  const platform = usePlatform()
  useEffect(() => {
    document.title = 'Workhub 2'
  }, [])
  return (
    <ToastProvider label={t('common.notifications')}>
      <div className="flex h-full flex-col bg-bg">
        {/* Room for the macOS traffic lights; Windows and Linux draw their controls over the right end. */}
        <div className={cn('drag-region h-10 shrink-0', platform === 'mac' ? 'pl-20' : 'pr-36')} />
        <main className="min-h-0 flex-1 overflow-y-auto">
          <PullRequestDetail profileId={profileId} url={url} />
        </main>
      </div>
    </ToastProvider>
  )
}

/** The window of one pull request (`#pr?profile=…&url=…`): the detail view alone. */
export function PullRequestWindow({ profileId, url }: { profileId: string | null; url: string }) {
  return (
    <I18nProvider>
      <TooltipProvider>
        <Frame profileId={profileId} url={url} />
      </TooltipProvider>
    </I18nProvider>
  )
}
