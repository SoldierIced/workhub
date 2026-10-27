import { failureRate, windowVerdict, type FlowDetails, type WindowStats } from '@workhub/core'
import { useI18n } from '../../i18n/I18nProvider'
import { cn } from '../../lib/cn'
import { formatMs, formatRate, verdictText } from '../../lib/health'

/** The span breakdown of a slow flow's slowest executions (a resource table) and its window comparison. */
export function FlowDetailsView({ details: d }: { details: FlowDetails }) {
  const i18n = useI18n()
  const { t, tn, formatNumber } = i18n
  const c = d.comparison
  const verdict = c ? windowVerdict(c) : undefined
  const head = 'px-2 py-1 text-xs font-normal text-subtle'
  return (
    <>
      {d.spansError ? (
        <p className="text-xs text-warning">{t('health.slow.spansFailed', { error: d.spansError })}</p>
      ) : d.spans.length === 0 ? (
        <p className="text-xs text-muted">{t('health.slow.noSpans')}</p>
      ) : (
        <section className="flex flex-col gap-1">
          <h4 className="text-xs font-semibold">{tn('health.slow.breakdown', d.sampledTransactions)}</h4>
          <div className="overflow-x-auto">
            <table className="w-full text-sm tabular-nums">
              <thead>
                <tr className="border-b border-border text-right">
                  <th className={cn(head, 'text-left')}>{t('health.slow.col.resource')}</th>
                  <th className={head}>{t('health.slow.col.calls')}</th>
                  <th className={head}>{t('health.slow.col.average')}</th>
                  <th className={head}>{t('health.slow.col.total')}</th>
                  <th className={head}>{t('health.slow.col.perRequest')}</th>
                  <th className={head} title={t('health.slow.shareHint')}>
                    {t('health.slow.col.share')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {d.spans.map((s) => (
                  <tr key={`${s.resource}|${s.type}|${s.subtype ?? ''}`} className="text-right">
                    <td className="max-w-56 px-2 py-1 text-left">
                      <span className="block truncate" title={s.resource}>
                        {s.resource}
                      </span>
                      <span className="block text-xs text-subtle">{[s.type, s.subtype].filter(Boolean).join(' · ')}</span>
                    </td>
                    <td className="px-2 py-1">{formatNumber(s.calls)}</td>
                    <td className="px-2 py-1">{formatMs(s.averageMs)}</td>
                    <td className="px-2 py-1">{formatMs(s.totalMs)}</td>
                    <td className="px-2 py-1">{s.callsPerTransaction.toFixed(1)}</td>
                    <td className="px-2 py-1" title={t('health.slow.shareHint')}>
                      {formatRate(s.shareOfWallTime)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {d.comparisonError ? (
        <p className="text-xs text-warning">{t('health.slow.compareFailed', { error: d.comparisonError })}</p>
      ) : (
        c &&
        verdict && (
          <section className="flex flex-col gap-1">
            <h4 className="text-xs font-semibold">{t('health.slow.compare.title', { hours: c.windowHours })}</h4>
            <table className="text-sm tabular-nums">
              <thead>
                <tr className="text-right">
                  <th className={cn(head, 'text-left')} />
                  <th className={head}>{t('health.slow.compare.previous')}</th>
                  <th className={head}>{t('health.slow.compare.current')}</th>
                </tr>
              </thead>
              <tbody>
                {(
                  [
                    ['health.slow.compare.calls', (w: WindowStats) => formatNumber(w.transactions)],
                    ['health.slow.compare.p95', (w: WindowStats) => (w.p95Ms === undefined ? '–' : formatMs(w.p95Ms))],
                    ['health.slow.compare.failed', (w: WindowStats) => formatRate(failureRate(w))],
                    ['health.slow.compare.errors', (w: WindowStats) => formatNumber(w.errors)]
                  ] as const
                ).map(([label, value]) => (
                  <tr key={label} className="text-right">
                    <td className="px-2 py-0.5 text-left text-muted">{t(label)}</td>
                    <td className="px-2 py-0.5">{value(c.previous)}</td>
                    <td className="px-2 py-0.5">{value(c.current)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className={cn('text-xs', verdict.kind === 'regressed' ? 'text-danger' : 'text-muted')}>{verdictText(verdict, i18n)}</p>
          </section>
        )
      )}
    </>
  )
}
