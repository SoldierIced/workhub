import type { PullRequestWindowTab } from '@shared/codehost-api'
import { TooltipProvider } from '../components/atoms'
import { ToastProvider } from '../components/molecules'
import { I18nProvider, useI18n } from '../i18n/I18nProvider'
import { PullRequestDetail } from './pullRequests/PullRequestDetail'

interface Props {
  profileId: string | null
  url: string
  tab?: PullRequestWindowTab
}

function Frame({ profileId, url, tab }: Props) {
  const { t } = useI18n()
  return (
    <ToastProvider label={t('common.notifications')}>
      {/* The detail's header is the title bar: no empty strip above it. */}
      <main className="h-full bg-bg">
        <PullRequestDetail profileId={profileId} url={url} standalone initialTab={tab} />
      </main>
    </ToastProvider>
  )
}

/** The window of one pull request (`#pr?profile=…&url=…[&tab=slack]`): the detail view alone, titled `repo#N · title`. */
export function PullRequestWindow(props: Props) {
  return (
    <I18nProvider>
      <TooltipProvider>
        <Frame {...props} />
      </TooltipProvider>
    </I18nProvider>
  )
}
