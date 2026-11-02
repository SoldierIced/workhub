import { ArrowRight } from 'lucide-react'
import { Button, StateDot } from '../atoms'
import { HOME_INSET_ROW, HomeCard, HomeNote } from '../molecules'
import { useI18n } from '../../i18n/I18nProvider'
import { changeText, metricName, openAlerts, SEVERITY_TONE } from '../../lib/metricAlerts'
import { useMetricAlerts } from '../../metricAlertsStore'

/** High-severity alerts Home lists before "View all". */
const TOP_ALERTS = 3

/** Home: how many metric alerts are open, and the top high-severity ones; a click opens Health → Alerts. */
export function OpenAlertsCard({ profileId, onOpen }: { profileId: string | undefined; onOpen: () => void }) {
  const { t, tn } = useI18n()
  const { view, loading } = useMetricAlerts(profileId)
  const open = openAlerts(view?.alerts ?? [])
  const high = open.filter((a) => a.severity === 'high' && a.status !== 'snoozed').slice(0, TOP_ALERTS)
  return (
    <HomeCard
      title={t('metricAlerts.home.title')}
      detail={view ? tn('metricAlerts.home.open', open.length) : undefined}
      trailing={
        <Button size="sm" variant="ghost" className="text-accent hover:text-accent" onClick={onOpen}>
          {t('metricAlerts.home.viewAll')}
          <ArrowRight className="size-3.5" aria-hidden />
        </Button>
      }
      data-testid="open-alerts-card"
    >
      {high.length > 0 ? (
        <ul className="flex flex-col gap-1.5">
          {high.map((a) => {
            const change = changeText(a, t('metricAlerts.points'))
            return (
              <li key={a.key}>
                <button type="button" onClick={onOpen} className={`${HOME_INSET_ROW} flex w-full items-center gap-2 text-left transition-colors hover:bg-surface-hover`}>
                  <StateDot tone={SEVERITY_TONE[a.severity]} />
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-semibold">{metricName(a, t)}</span> <span className="text-muted">· {a.segment ? `${a.subject} · ${a.segment}` : a.subject}</span>
                  </span>
                  {change && <span className="shrink-0 text-sm font-medium tabular-nums">{change}</span>}
                </button>
              </li>
            )
          })}
        </ul>
      ) : (
        <HomeNote text={!view ? (loading ? t('metricAlerts.loading') : t('metricAlerts.home.none')) : open.length > 0 ? t('metricAlerts.home.noHigh') : t('metricAlerts.home.none')} />
      )}
    </HomeCard>
  )
}
