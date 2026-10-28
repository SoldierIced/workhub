import { Activity } from 'lucide-react'
import type { Profile } from '@workhub/core'
import { Badge, StateDot } from '../../components/atoms'
import { useHealth } from '../../healthStore'
import { useI18n } from '../../i18n/I18nProvider'
import { HEALTH_LABEL, HEALTH_TONE } from '../../lib/health'

/**
 * Home: one pill per Health environment, in the order Settings lists them (the same order as the
 * Health screen's tabs); a click opens Health. Before anything is read it says why.
 */
export function HealthPills({ profile, onOpenHealth, onOpenSettings }: { profile: Profile | undefined; onOpenHealth: () => void; onOpenSettings: (tab?: string) => void }) {
  const { t } = useI18n()
  const { view } = useHealth(profile?.id, true)
  const environments = view?.environments ?? []
  return (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <span className="font-medium text-muted">{t('home.environments')}</span>
      {environments.length > 0 ? (
        environments.map((e) => (
          <button
            key={e.id}
            type="button"
            onClick={onOpenHealth}
            title={t('health.pill.open')}
            aria-label={t('health.pill.title', { name: e.name, state: t(HEALTH_LABEL[e.snapshot.state]) })}
            className="inline-flex h-6 items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 text-xs font-medium text-text transition-colors hover:bg-surface-hover"
          >
            <StateDot tone={HEALTH_TONE[e.snapshot.state]} />
            {e.name}
            <span className="text-muted">{t(HEALTH_LABEL[e.snapshot.state])}</span>
          </button>
        ))
      ) : (
        <button type="button" onClick={() => onOpenSettings('health')} className="rounded-full">
          <Badge tone="neutral" icon={<Activity className="size-3" aria-hidden />}>
            {view ? t('home.notConnected.health') : t('health.loading')}
          </Badge>
        </button>
      )}
    </div>
  )
}
