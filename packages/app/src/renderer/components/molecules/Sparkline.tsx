import { cn } from '../../lib/cn'
import { sparklinePoints } from '../../lib/metricAlerts'

/** A tiny inline SVG line of a few values (oldest left), no chart library; the last value is marked. */
export function Sparkline({ values, label, width = 96, height = 24, className }: { values: readonly number[]; label: string; width?: number; height?: number; className?: string }) {
  const points = sparklinePoints(values, width, height)
  const last = points.split(' ').at(-1)?.split(',').map(Number)
  return (
    <svg role="img" aria-label={label} width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={cn('shrink-0 text-accent', className)}>
      {values.length > 1 && <polyline points={points} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />}
      {last && last.length === 2 && <circle cx={last[0]} cy={last[1]} r={2} fill="currentColor" />}
    </svg>
  )
}
