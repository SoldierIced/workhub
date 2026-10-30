import { RotateCcw, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { FLOW_TRACE_SORTS, flowPartLabel, formatMs, type FlowMap, type FlowPartRef, type FlowTrace, type FlowTraceLog, type FlowTraceSort, type FlowTraceSummary } from '@workhub/core'
import type { FlowTraceLogsResult, FlowTraceResult, FlowTracesResult } from '@shared/health-api'
import { Button, Spinner } from '../../components/atoms'
import { CopyButton } from '../../components/molecules'
import { useI18n } from '../../i18n/I18nProvider'
import { cn } from '../../lib/cn'
import { errorText } from '../../lib/errorText'
import { WAIT } from './FlowMapSvg'

export interface TracesPanelProps {
  map: FlowMap
  hours: number
  list: (sort: FlowTraceSort) => Promise<FlowTracesResult>
  selectedId: string | null
  /** The selected execution once read; null while none is selected, `{ ok: false }` when it failed. */
  selected: FlowTraceResult | null
  loadingTrace: boolean
  /** The selected execution's APM errors and log lines (the view holds them: the Claude draft uses them too). */
  logs?: FlowTraceLogsResult | null
  loadingLogs?: boolean
  onSelect: (traceId: string | null) => void
  picked: FlowPartRef | null
  onPick: (p: FlowPartRef | null) => void
}

/** The real executions of the flow: a list to pick from (latest, slowest, failed), and the picked one as a waterfall over the map's parts. */
export function TracesPanel({ map, hours, list, selectedId, selected, loadingTrace, logs = null, loadingLogs = false, onSelect, picked, onPick }: TracesPanelProps) {
  const { t, locale } = useI18n()
  const [sort, setSort] = useState<FlowTraceSort>('latest')
  const [traces, setTraces] = useState<FlowTraceSummary[] | null>(null)
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(false)
  const load = () => {
    setLoading(true)
    list(sort)
      .then((r) => {
        if (r.ok) {
          setTraces(r.traces)
          setError(undefined)
        } else {
          setTraces([])
          setError(r.error)
        }
      })
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setLoading(false))
  }
  useEffect(() => void load(), [sort, hours]) // eslint-disable-line react-hooks/exhaustive-deps
  const when = (at: number) => new Date(at).toLocaleString(locale, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const outcomeClass = (o: FlowTraceSummary['outcome']) => (o === 'failure' ? 'text-danger' : o === 'success' ? 'text-success' : 'text-muted')
  return (
    <div className="grid gap-3 md:grid-cols-[minmax(260px,340px)_1fr]" data-testid="flow-traces">
      <div className="flex min-h-0 flex-col gap-2">
        <div className="flex items-center gap-1">
          <div role="group" aria-label={t('flowMaps.traces.title')} className="flex gap-1">
            {FLOW_TRACE_SORTS.map((s) => (
              <Button key={s} size="sm" variant={s === sort ? 'primary' : 'ghost'} onClick={() => setSort(s)}>
                {t(`flowMaps.traces.sort.${s}`)}
              </Button>
            ))}
          </div>
          <span className="flex-1" />
          <Button size="sm" variant="ghost" icon={loading ? <Spinner /> : <RotateCcw className="size-3.5" aria-hidden />} disabled={loading} onClick={load}>
            {t('flowMaps.reload')}
          </Button>
        </div>
        {error && <p className="text-sm text-danger">{error}</p>}
        {!traces && !error && <p className="flex items-center gap-2 text-sm text-muted"><Spinner /> {t('flowMaps.traces.loading')}</p>}
        {traces && traces.length === 0 && !error && <p className="text-sm text-muted">{t('flowMaps.traces.empty')}</p>}
        {traces && traces.length > 0 && (
          <div className="max-h-[360px] overflow-y-auto rounded-md border border-border">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-surface text-left text-muted">
                <tr>
                  <th className="px-2 py-1 font-medium">{t('flowMaps.traces.when')}</th>
                  <th className="px-2 py-1 text-right font-medium">{t('flowMaps.traces.duration')}</th>
                  <th className="px-2 py-1 text-right font-medium">{t('flowMaps.traces.outcome')}</th>
                </tr>
              </thead>
              <tbody>
                {traces.map((tr) => (
                  <tr key={tr.traceId} className={cn('cursor-pointer border-t border-border hover:bg-surface-hover', tr.traceId === selectedId && 'bg-accent-soft')} onClick={() => onSelect(tr.traceId === selectedId ? null : tr.traceId)} title={tr.traceId}>
                    <td className="px-2 py-1 tabular-nums">{when(tr.at)}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{formatMs(tr.durationMs)}</td>
                    <td className={cn('px-2 py-1 text-right', outcomeClass(tr.outcome))}>{t(`flowMaps.traces.outcome.${tr.outcome}`)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="min-w-0 rounded-md border border-border p-3">
        {!selectedId && <p className="text-sm text-muted">{t('flowMaps.traces.pick')}</p>}
        {selectedId && loadingTrace && <p className="flex items-center gap-2 text-sm text-muted"><Spinner /> {t('flowMaps.traces.reading')}</p>}
        {selectedId && !loadingTrace && selected && !selected.ok && <p className="text-sm text-danger">{selected.error}</p>}
        {selectedId && !loadingTrace && selected?.ok && <TraceDetail map={map} trace={selected.trace} logs={logs} loadingLogs={loadingLogs} picked={picked} onPick={onPick} onClear={() => onSelect(null)} />}
      </div>
    </div>
  )
}

/** One execution: a header, the parts as a waterfall (start offset and duration on one time axis), what it never touched and what it did beyond the map. */
function TraceDetail({ map, trace, logs, loadingLogs, picked, onPick, onClear }: { map: FlowMap; trace: FlowTrace; logs: FlowTraceLogsResult | null; loadingLogs: boolean; picked: FlowPartRef | null; onPick: (p: FlowPartRef | null) => void; onClear: () => void }) {
  const { t, tn, locale } = useI18n()
  const hops = Object.values(trace.hops).sort((a, b) => a.startMs - b.startMs || b.durationMs - a.durationMs)
  const total = Math.max(1, trace.durationMs, ...hops.map((h) => h.startMs + h.durationMs))
  const pct = (v: number) => `${Math.min(100, Math.max(0, (v / total) * 100))}%`
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">{t('flowMaps.traces.selected', { when: new Date(trace.at).toLocaleString(locale), duration: formatMs(trace.durationMs) })}</span>
        <span className={cn('text-xs', trace.outcome === 'failure' ? 'text-danger' : trace.outcome === 'success' ? 'text-success' : 'text-muted')}>{t(`flowMaps.traces.outcome.${trace.outcome}`)}</span>
        <code className="truncate rounded bg-surface-raised px-1.5 py-0.5 text-[11px] text-muted" title={trace.traceId}>{trace.traceId}</code>
        <CopyButton text={() => trace.traceId} />
        <span className="flex-1" />
        <Button size="sm" variant="ghost" icon={<X className="size-3.5" aria-hidden />} onClick={onClear}>
          {t('flowMaps.traces.clear')}
        </Button>
      </div>
      <div>
        <p className="mb-1 text-xs font-medium text-muted">{t('flowMaps.traces.hops')}</p>
        <p className="mb-2 text-[11px] text-subtle">{t('flowMaps.traces.hopsHint')}</p>
        {hops.length === 0 && <p className="text-sm text-muted">—</p>}
        <ul className="flex flex-col gap-1" data-testid="flow-trace-waterfall">
          {hops.map((h) => {
            const active = picked?.of === h.of && picked.key === h.key
            return (
              <li key={`${h.of}:${h.key}`} className={cn('grid cursor-pointer grid-cols-[minmax(120px,32%)_1fr_auto] items-center gap-2 rounded px-1 py-0.5 text-xs hover:bg-surface-hover', active && 'bg-accent-soft')} onClick={() => onPick(active ? null : { of: h.of, key: h.key })}>
                <span className="truncate" title={flowPartLabel(map, h)}>{flowPartLabel(map, h)}</span>
                <span className="relative h-3 rounded bg-surface-raised">
                  <span className="absolute inset-y-0 rounded" style={{ left: pct(h.startMs), width: `max(2px, ${pct(h.durationMs)})`, background: h.failed ? WAIT : 'var(--color-accent, #22d3ee)' }} />
                </span>
                <span className="whitespace-nowrap tabular-nums text-muted">
                  +{formatMs(h.startMs)} · {formatMs(h.durationMs)}
                  {h.count > 1 ? ` · ${tn('flowMaps.traces.times', h.count)}` : ''}
                </span>
              </li>
            )
          })}
        </ul>
      </div>
      {trace.missing.length > 0 && (
        <div>
          <p className="mb-1 text-xs font-medium text-muted">{t('flowMaps.traces.missing')}</p>
          <p className="text-xs">{trace.missing.map((k) => flowPartLabel(map, { of: partOf(map, k), key: k })).join(' · ')}</p>
        </div>
      )}
      {trace.unmapped.length > 0 && (
        <div>
          <p className="mb-1 text-xs font-medium text-muted">{t('flowMaps.traces.unmapped')}</p>
          <p className="mb-1 text-[11px] text-subtle">{t('flowMaps.traces.unmappedHint')}</p>
          <table className="w-full text-xs" data-testid="flow-trace-unmapped">
            <tbody>
              {trace.unmapped.map((u, i) => (
                <tr key={i} className="border-t border-border">
                  <td className="py-0.5 pr-2 text-muted">{t(u.event === 'span' ? 'flowMaps.traces.span' : 'flowMaps.traces.transaction')}</td>
                  <td className="py-0.5 pr-2 font-medium">{u.service}</td>
                  <td className="truncate py-0.5 pr-2" title={u.name}>{u.event === 'span' ? `→ ${u.destination ?? u.name}` : u.name}</td>
                  <td className="whitespace-nowrap py-0.5 text-right tabular-nums text-muted">
                    +{formatMs(u.startMs)} · {formatMs(u.durationMs)}
                    {u.count > 1 ? ` · ${tn('flowMaps.traces.times', u.count)}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <LogsSection trace={trace} logs={logs} loading={loadingLogs} />
    </div>
  )
}

const LEVEL_TONE: Record<string, string> = { error: 'bg-danger/15 text-danger', warn: 'bg-warning/15 text-warning', info: 'bg-surface-raised text-muted' }
const levelOf = (l: FlowTraceLog) => (l.level ?? (l.source === 'apm.error' ? 'error' : 'log')).toLowerCase()
const toneOf = (level: string) => LEVEL_TONE[level === 'warning' ? 'warn' : level] ?? (['fatal', 'critical'].includes(level) ? LEVEL_TONE.error : 'bg-surface-raised text-muted')

/** The APM errors and log lines of the execution, oldest first, each at its offset from the start; click a message for its full text. */
export function LogsSection({ trace, logs, loading }: { trace: Pick<FlowTrace, 'at'>; logs: FlowTraceLogsResult | null; loading: boolean }) {
  const { t } = useI18n()
  const [open, setOpen] = useState<Set<number>>(new Set())
  const toggle = (i: number) => setOpen((prev) => {
    const next = new Set(prev)
    if (!next.delete(i)) next.add(i)
    return next
  })
  return (
    <div data-testid="flow-trace-logs">
      <p className="mb-1 text-xs font-medium text-muted">{t('flowMaps.logs.title')}</p>
      {loading && <p className="flex items-center gap-2 text-sm text-muted"><Spinner /> {t('flowMaps.logs.loading')}</p>}
      {!loading && logs && !logs.ok && <p className="text-sm text-danger">{t('flowMaps.logs.failed', { error: logs.error })}</p>}
      {!loading && logs?.ok && logs.logs.length === 0 && <p className="text-sm text-muted">{t('flowMaps.logs.empty')}</p>}
      {!loading && logs?.ok && logs.logs.length > 0 && (
        <ul className="max-h-[260px] overflow-y-auto rounded-md border border-border text-xs">
          {logs.logs.map((l, i) => {
            const level = levelOf(l)
            const expanded = open.has(i)
            return (
              <li key={i} className="grid grid-cols-[auto_auto_auto_1fr] items-baseline gap-x-2 border-t border-border px-2 py-1 first:border-t-0">
                <span className="whitespace-nowrap tabular-nums text-muted">+{(Math.max(0, l.at - trace.at) / 1000).toFixed(2)} s</span>
                <span className="max-w-[140px] truncate font-medium" title={l.service}>{l.service}</span>
                <span className={cn('rounded px-1.5 py-px text-[10px] font-medium uppercase', toneOf(level))}>{level}</span>
                <div className="min-w-0">
                  <button type="button" className={cn('block w-full text-left', expanded ? 'whitespace-pre-wrap break-words' : 'truncate')} title={l.message} aria-expanded={expanded} onClick={() => toggle(i)}>
                    {l.message}
                  </button>
                  {l.source === 'apm.error' && (l.type || l.culprit) && <span className="block truncate text-[11px] text-subtle" title={[l.type, l.culprit].filter(Boolean).join(' · ')}>{[l.type, l.culprit].filter(Boolean).join(' · ')}</span>}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

function partOf(map: FlowMap, key: string): 'edges' | 'nodes' | 'stages' {
  if (map.nodes.some((n) => n.id === key)) return 'nodes'
  if (map.stages.some((s) => s.id === key)) return 'stages'
  return 'edges'
}
