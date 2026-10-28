import { RefreshButton } from './RefreshButton'
import { useI18n } from '../../i18n/I18nProvider'
import { useUsageRefresh } from '../../lib/usage'

/**
 * Refreshes every account's plan usage (Claude, Codex, Kiro) now, bypassing the readers' caches;
 * spins while reading. The tooltip tells when the newest read happened.
 */
export function UsageRefreshButton({ size = 'sm', className }: { size?: 'sm' | 'md'; className?: string }) {
  const { t, formatDate } = useI18n()
  const { refreshing, refresh, updatedAt } = useUsageRefresh()
  const when = updatedAt === null ? t('agentUsage.notReadYet') : t('agentUsage.updatedAt', { time: formatDate(updatedAt, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) })
  return (
    <RefreshButton
      size={size}
      className={className}
      label={refreshing ? t('agentUsage.refreshing') : t('agentUsage.refresh')}
      hint={<span className="text-subtle">{when}</span>}
      title={when}
      data-testid="usage-refresh"
      loading={refreshing}
      onRefresh={refresh}
    />
  )
}
