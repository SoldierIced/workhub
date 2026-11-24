import { GitPullRequest, TriangleAlert } from 'lucide-react'
import { Button } from '../../components/atoms'
import { EmptyState, RefreshButton } from '../../components/molecules'
import { useI18n } from '../../i18n/I18nProvider'
import { installUrl, loginCommand } from '../../lib/pullRequests'

export interface UnavailableProps {
  state: string
  /** The host's own text when the read failed. */
  message?: string
  /** When a rate limit lifts (ms since the epoch), for the rateLimited state. */
  retryAt?: number
  provider?: string
  cli?: string
  onOpenSettings: (tab?: string) => void
  onRetry: () => unknown
}

/** Why there is nothing to show: no connection, a missing CLI, no login, or a failed read. */
export function Unavailable({ state, message, retryAt, provider, cli: cliName, onOpenSettings, onRetry }: UnavailableProps) {
  const { t, formatDate } = useI18n()
  const cli = cliName ?? 'gh'
  const host = provider === 'gitlab' ? t('pr.host.gitlab') : t('pr.host.github')
  const retry = (
    <RefreshButton variant="button" size="md" iconClassName="size-4" label={t('pr.retry')} onRefresh={onRetry} />
  )
  const icon = <TriangleAlert className="size-6" aria-hidden />
  switch (state) {
    case 'notConnected':
      return (
        <EmptyState
          icon={<GitPullRequest className="size-6" aria-hidden />}
          title={t('pr.notConnected.title')}
          description={t('pr.notConnected.description')}
          action={<Button variant="primary" onClick={() => onOpenSettings('connections')}>{t('pr.openSettings')}</Button>}
        />
      )
    case 'missingCli':
      return <EmptyState icon={icon} title={t('pr.missingCli.title', { cli })} description={t('pr.missingCli.description', { cli, url: installUrl(cli) })} action={retry} />
    case 'signedOut':
      return <EmptyState icon={icon} title={t('pr.signedOut.title', { host })} description={t('pr.signedOut.description', { command: loginCommand(cli) })} action={retry} />
    case 'rateLimited':
      return (
        <EmptyState
          icon={icon}
          title={t('pr.rateLimited.title')}
          description={retryAt !== undefined ? t('pr.rateLimited.description', { time: formatDate(retryAt, { hour: '2-digit', minute: '2-digit' }) }) : message}
          action={retry}
        />
      )
    default:
      return <EmptyState icon={icon} title={t('pr.error.title')} description={message} action={retry} />
  }
}
