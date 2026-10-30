import { formatMs, worstHour, type FlowTiming } from '@workhub/core'
import { useI18n } from '../../i18n/I18nProvider'
import { WAIT } from './FlowMapSvg'

/**
 * Calls per hour as bars and p95 per hour as a line, with both scales on the sides and a legend, so
 * the reader knows what each mark is: when the part got busy, and when it got slow. The slowest
 * hour's bar is marked.
 */
export function HourlyChart({ timing, hours }: { timing: FlowTiming; hours: number }) {
  const { t, locale, formatNumber } = useI18n()
  const W = 360, H = 90, padX = 30, padY = 6
  const pts = timing.hourly
  if (pts.length === 0) return null
  const maxCount = Math.max(1, ...pts.map((p) => p.count))
  const maxP95 = Math.max(1, ...pts.map((p) => p.p95Ms))
  const innerW = W - padX * 2, innerH = H - padY * 2
  const bw = innerW / pts.length
  const yCount = (c: number) => H - padY - (c / maxCount) * innerH
  const yP95 = (ms: number) => H - padY - (ms / maxP95) * innerH
  const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${padX + i * bw + bw / 2} ${yP95(p.p95Ms)}`).join(' ')
  const hour = (at: number) => new Date(at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
  const worst = worstHour(timing)
  const every = Math.max(1, Math.round(pts.length / 6))
  return (
    <figure className="flex flex-col gap-1">
      <figcaption className="text-xs font-medium text-muted">{t('flowMaps.chart.title', { hours })}</figcaption>
      <svg viewBox={`0 0 ${W} ${H + 14}`} className="w-full" role="img" aria-label={t('flowMaps.chart.title', { hours })}>
        <line x1={padX} y1={H - padY} x2={W - padX} y2={H - padY} stroke="currentColor" className="text-border" />
        <text x={padX - 4} y={padY + 8} fontSize={8} textAnchor="end" fill="currentColor" className="text-accent">{formatNumber(maxCount)}</text>
        <text x={padX - 4} y={H - padY} fontSize={8} textAnchor="end" fill="currentColor" className="text-muted">0</text>
        <text x={W - padX + 4} y={padY + 8} fontSize={8} fill={WAIT}>{formatMs(maxP95)}</text>
        <text x={W - padX + 4} y={H - padY} fontSize={8} fill="currentColor" className="text-muted">0</text>
        {pts.map((p, i) => {
          const isWorst = worst?.at === p.at
          return (
            <rect key={p.at} x={padX + i * bw + 1} y={yCount(p.count)} width={Math.max(1, bw - 2)} height={(p.count / maxCount) * innerH} fill={isWorst ? WAIT : 'currentColor'} fillOpacity={isWorst ? 0.55 : undefined} className={isWorst ? undefined : 'text-accent/35'}>
              <title>{t('flowMaps.chart.point', { hour: hour(p.at), count: formatNumber(p.count), p50: formatMs(p.p50Ms), p95: formatMs(p.p95Ms) })}</title>
            </rect>
          )
        })}
        <path d={line} fill="none" stroke={WAIT} strokeWidth={1.5} />
        {pts.map((p, i) =>
          i % every === 0 ? (
            <text key={p.at} x={padX + i * bw} y={H + 10} fontSize={8} fill="currentColor" className="text-muted">{hour(p.at)}</text>
          ) : null
        )}
      </svg>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted">
        <span className="inline-flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-accent/40" aria-hidden /> {t('flowMaps.chart.calls', { max: formatNumber(maxCount) })}</span>
        <span className="inline-flex items-center gap-1"><span className="inline-block h-0.5 w-3" style={{ background: WAIT }} aria-hidden /> {t('flowMaps.chart.p95', { max: formatMs(maxP95) })}</span>
      </div>
    </figure>
  )
}
