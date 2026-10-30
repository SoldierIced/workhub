import { AppWindow, Copy, ListOrdered, Maximize2, Minus, Pause, Play, Plus, RotateCcw, Sparkles, Waypoints, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { breaches, flowAlertsOf, flowCoverage, flowMeasures, flowPartLabel, flowParts, flowThresholds, formatMs, hasFlowAlerts, layoutFlowMap, rankFlowDeviations, rankFlowParts, worstHour, type FlowBaseline, type FlowCoverage, type FlowMap, type FlowMapReading, type FlowNodeKind, type FlowPartRef, type FlowTiming, type FlowTrace, type FlowTraceSort } from '@workhub/core'
import type { FlowMapResult, FlowTraceLogsResult, FlowTraceResult, HealthEnvironmentView } from '@shared/health-api'
import { Button, IconButton, Spinner } from '../../components/atoms'
import { Tabs, useToast } from '../../components/molecules'
import { useI18n } from '../../i18n/I18nProvider'
import { cn } from '../../lib/cn'
import { errorText } from '../../lib/errorText'
import { FlowMapSvg, flowMapToPng, KIND_COLOR, WAIT } from './FlowMapSvg'
import { FlowSequenceSvg, sequenceLayout } from './FlowSequenceSvg'
import { flowMapPrompt } from './flowMapPrompt'
import { HourlyChart } from './HourlyChart'
import { TracesPanel } from './TracesPanel'

const WINDOWS = [6, 24, 72, 168]
const ZOOM_STEPS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2]
type Tab = 'parts' | 'executions' | 'coverage' | 'alerts' | 'legend'

export interface FlowMapViewProps {
  env: HealthEnvironmentView
  profileId: string | null
  mapId: string
  /** The map's file, named in the Claude draft so the session can edit it. */
  file?: string
  /** Main window: opens a Claude session with the draft. Absent in the map window, which asks the main window instead. */
  onAsk?: (draft: string, folder: string | undefined) => void
  /** Whether "Open in a window" shows (not inside the window itself). */
  canOpenWindow?: boolean
}

/**
 * One map: the toolbar (window, Flow/Still, zoom, copy as image, own window, Ask Claude), a line
 * saying how much is measured and where the time goes, the diagram, and the tabs under it: the
 * parts with their numbers, the real executions, the coverage and the legend.
 */
export function FlowMapView({ env, profileId, mapId, file, onAsk, canOpenWindow = true }: FlowMapViewProps) {
  const { t, tn, locale } = useI18n()
  const toast = useToast()
  const [hours, setHours] = useState(24)
  const [result, setResult] = useState<FlowMapResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [flow, setFlow] = useState(true)
  const [picked, setPicked] = useState<FlowPartRef | null>(null)
  const [tab, setTab] = useState<Tab>('parts')
  const [view, setView] = useState<'map' | 'sequence'>('map')
  const [zoom, setZoom] = useState<number | 'fit'>('fit')
  const [fitScale, setFitScale] = useState(1)
  const [traceId, setTraceId] = useState<string | null>(null)
  const [trace, setTrace] = useState<FlowTraceResult | null>(null)
  const [loadingTrace, setLoadingTrace] = useState(false)
  const [logs, setLogs] = useState<FlowTraceLogsResult | null>(null)
  const [loadingLogs, setLoadingLogs] = useState(false)
  const svgRef = useRef<SVGSVGElement>(null)
  const scroller = useRef<HTMLDivElement>(null)

  const load = (force = false) => {
    setLoading(true)
    window.hub.health
      .flowMap(profileId, env.id, mapId, hours, force)
      .then(setResult)
      .catch((e: unknown) => setResult({ ok: false, error: errorText(e) }))
      .finally(() => setLoading(false))
  }
  useEffect(() => void load(), [profileId, env.id, mapId, hours]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!traceId) return setTrace(null)
    let alive = true
    setLoadingTrace(true)
    window.hub.health
      .flowTrace(profileId, env.id, mapId, traceId)
      .then((r) => alive && setTrace(r))
      .catch((e: unknown) => alive && setTrace({ ok: false, error: errorText(e) }))
      .finally(() => alive && setLoadingTrace(false))
    return () => {
      alive = false
    }
  }, [profileId, env.id, mapId, traceId])
  useEffect(() => {
    setLogs(null)
    if (!traceId) return setLoadingLogs(false)
    let alive = true
    setLoadingLogs(true)
    window.hub.health
      .flowTraceLogs(profileId, env.id, mapId, traceId)
      .then((r) => alive && setLogs(r))
      .catch((e: unknown) => alive && setLogs({ ok: false, error: errorText(e) }))
      .finally(() => alive && setLoadingLogs(false))
    return () => {
      alive = false
    }
  }, [profileId, env.id, mapId, traceId])

  const map = result?.ok ? result.map : null
  const reading = result?.ok ? result.reading : undefined
  const layout = useMemo(() => (map ? layoutFlowMap(map) : null), [map])
  const ranks = useMemo(() => (map && reading ? rankFlowParts(map, reading) : []), [map, reading])
  const coverage = useMemo(() => (map ? flowCoverage(map, reading) : null), [map, reading])
  const selectedTrace: FlowTrace | null = trace?.ok ? trace.trace : null
  const sequence = useMemo(() => (map ? sequenceLayout(map, selectedTrace) : null), [map, selectedTrace])
  const diagramWidth = view === 'sequence' && sequence ? sequence.width : layout?.width ?? 1
  const breached = useMemo(() => (map && reading ? new Set(flowAlertsOf(map, reading, { id: env.id, name: env.name }).map((a) => `${a.part.of}:${a.part.key}`)).size : 0), [map, reading, env.id, env.name])

  // Fit: the diagram's natural width against the scroller's; measured again when the scroller resizes.
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el || !layout) return
    const measure = () => setFitScale(Math.min(1.5, Math.max(0.3, (el.clientWidth - 2) / diagramWidth)))
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [layout, diagramWidth])
  const scale = zoom === 'fit' ? fitScale : zoom
  const step = (dir: 1 | -1) => {
    const current = scale
    const next = dir > 0 ? ZOOM_STEPS.find((z) => z > current + 0.01) : [...ZOOM_STEPS].reverse().find((z) => z < current - 0.01)
    if (next) setZoom(next)
  }

  const copyImage = async () => {
    const svg = svgRef.current
    if (!svg) return
    try {
      const ok = await window.hub.flowMaps.copyImage(await flowMapToPng(svg))
      if (!ok) throw new Error('clipboard')
      toast(t('flowMaps.copied'))
    } catch (e) {
      toast(t('flowMaps.copyFailed', { message: errorText(e) }), 'danger')
    }
  }
  const ask = () => {
    if (!map) return
    const draft = flowMapPrompt((k, p) => t(k, p), { map, file: file ?? `${mapId}.json`, environment: env.name, reading, trace: selectedTrace, logs: logs?.ok ? logs.logs : null, locale })
    if (onAsk) onAsk(draft, undefined)
    else window.hub.flowMaps.ask(draft)
  }

  if (!result) return <p className="flex items-center gap-2 text-sm text-muted"><Spinner /> {t('flowMaps.loading')}</p>
  if (!result.ok || !map || !layout || !coverage) return <p className="text-sm text-danger">{result.ok ? '' : result.error}</p>
  const slowest = ranks[0]
  const pct = (r: number) => `${Math.round(r * 100)} %`

  return (
    <div className="flex flex-col gap-3" data-testid="flow-map-view">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-semibold">{map.name}</span>
        {map.description && <span className="text-muted">{map.description}</span>}
        <span className="flex-1" />
        <div role="group" aria-label={t('flowMaps.window')} className="flex gap-1">
          {WINDOWS.map((h) => (
            <Button key={h} size="sm" variant={h === hours ? 'primary' : 'ghost'} onClick={() => setHours(h)}>
              {h < 24 ? `${h} h` : `${h / 24} d`}
            </Button>
          ))}
        </div>
        <div role="group" aria-label={t('flowMaps.view')} className="flex gap-1">
          <Button size="sm" variant={view === 'map' ? 'primary' : 'ghost'} icon={<Waypoints className="size-3.5" aria-hidden />} onClick={() => { setView('map'); setZoom('fit') }}>
            {t('flowMaps.view.map')}
          </Button>
          <Button size="sm" variant={view === 'sequence' ? 'primary' : 'ghost'} icon={<ListOrdered className="size-3.5" aria-hidden />} onClick={() => { setView('sequence'); setZoom(1) }}>
            {t('flowMaps.view.sequence')}
          </Button>
        </div>
        <Button size="sm" variant="ghost" icon={flow ? <Pause className="size-3.5" aria-hidden /> : <Play className="size-3.5" aria-hidden />} onClick={() => setFlow(!flow)}>
          {flow ? t('flowMaps.still') : t('flowMaps.flow')}
        </Button>
        <div role="group" aria-label="zoom" className="flex items-center gap-0.5 rounded-md border border-border px-0.5">
          <IconButton size="sm" label={t('flowMaps.zoomOut')} icon={<Minus className="size-3.5" aria-hidden />} onClick={() => step(-1)} />
          <span className="w-10 text-center text-xs tabular-nums text-muted">{Math.round(scale * 100)} %</span>
          <IconButton size="sm" label={t('flowMaps.zoomIn')} icon={<Plus className="size-3.5" aria-hidden />} onClick={() => step(1)} />
          <IconButton size="sm" label={t('flowMaps.zoomFit')} icon={<Maximize2 className="size-3.5" aria-hidden />} onClick={() => setZoom('fit')} />
        </div>
        <IconButton size="sm" label={t('flowMaps.copyImage')} icon={<Copy className="size-3.5" aria-hidden />} onClick={() => void copyImage()} />
        {canOpenWindow && <IconButton size="sm" label={t('flowMaps.openWindow')} icon={<AppWindow className="size-3.5" aria-hidden />} onClick={() => window.hub.flowMaps.openWindow(profileId, env.id, mapId)} />}
        <Button size="sm" variant="ghost" icon={<Sparkles className="size-3.5" aria-hidden />} title={t('flowMaps.askHint')} onClick={ask}>
          {t('flowMaps.ask')}
        </Button>
        <Button size="sm" variant="ghost" icon={loading ? <Spinner /> : <RotateCcw className="size-3.5" aria-hidden />} disabled={loading} onClick={() => load(true)}>
          {t('flowMaps.refresh')}
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted" data-testid="flow-map-summary">
        <span>{t('flowMaps.summary.measured', { measured: coverage.measured, total: coverage.total })}</span>
        {coverage.unmeasured.length > 0 && <button type="button" className="underline-offset-2 hover:underline" onClick={() => setTab('coverage')}>{tn('flowMaps.summary.unmeasured', coverage.unmeasured.length)}</button>}
        {coverage.noData.length > 0 && <button type="button" className="text-warning underline-offset-2 hover:underline" onClick={() => setTab('coverage')}>{tn('flowMaps.summary.noData', coverage.noData.length)}</button>}
        {coverage.failed.length > 0 && <button type="button" className="text-danger underline-offset-2 hover:underline" onClick={() => setTab('coverage')}>{tn('flowMaps.summary.failed', coverage.failed.length)}</button>}
        <span className="flex-1" />
        {reading && slowest && (
          <button type="button" className="text-text underline-offset-2 hover:underline" onClick={() => setPicked({ of: slowest.of, key: slowest.key })}>
            {t('flowMaps.summary.slowest', { label: slowest.label, p95: formatMs(slowest.timing.p95Ms), share: pct(slowest.share) })}
          </button>
        )}
        {reading && !slowest && <span>{t('flowMaps.summary.noNumbers')}</span>}
      </div>

      {reading && <DeviationLine map={map} reading={reading} onPick={setPicked} />}

      {selectedTrace && (
        <div className="flex items-center gap-2 rounded-md border border-accent/40 bg-accent-soft px-3 py-1.5 text-xs" data-testid="flow-trace-banner">
          <span className="font-medium">{t('flowMaps.traces.selected', { when: new Date(selectedTrace.at).toLocaleString(locale), duration: formatMs(selectedTrace.durationMs) })}</span>
          <span className="flex-1" />
          <Button size="sm" variant="ghost" icon={<X className="size-3.5" aria-hidden />} onClick={() => setTraceId(null)}>
            {t('flowMaps.traces.clear')}
          </Button>
        </div>
      )}

      <div ref={scroller} className="overflow-auto rounded-md border border-border bg-bg" style={{ maxHeight: '70vh' }}>
        {view === 'map' ? (
          <FlowMapSvg svgRef={svgRef} map={map} reading={reading} trace={selectedTrace} flow={flow} picked={picked} onPick={setPicked} ranks={ranks} coverage={coverage} scale={scale} />
        ) : (
          <FlowSequenceSvg svgRef={svgRef} map={map} reading={reading} trace={selectedTrace} flow={flow} picked={picked} onPick={setPicked} ranks={ranks} coverage={coverage} scale={scale} />
        )}
      </div>

      <Tabs
        label={map.name}
        value={tab}
        onChange={(v) => setTab(v as Tab)}
        items={[
          { value: 'parts', label: t('flowMaps.tab.parts'), content: <PartsTab map={map} reading={reading} ranks={ranks} coverage={coverage} trace={selectedTrace} picked={picked} onPick={setPicked} /> },
          {
            value: 'executions',
            label: t('flowMaps.tab.executions'),
            content: (
              <TracesPanel
                map={map}
                hours={hours}
                list={(sort: FlowTraceSort) => window.hub.health.flowTraces(profileId, env.id, mapId, hours, sort)}
                selectedId={traceId}
                selected={trace}
                loadingTrace={loadingTrace}
                logs={logs}
                loadingLogs={loadingLogs}
                onSelect={setTraceId}
                picked={picked}
                onPick={setPicked}
              />
            )
          },
          { value: 'coverage', label: t('flowMaps.tab.coverage'), content: <CoverageTab coverage={coverage} onPick={setPicked} /> },
          { value: 'alerts', label: breached > 0 ? t('flowMaps.tab.alertsCount', { count: breached }) : t('flowMaps.tab.alerts'), content: <AlertsTab map={map} reading={reading} onPick={setPicked} /> },
          { value: 'legend', label: t('flowMaps.tab.legend'), content: <Legend /> }
        ]}
        contentClassName="pt-3"
      />
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted">{label}</dt>
      <dd className="font-semibold tabular-nums">{value}</dd>
    </div>
  )
}

/** Every part, slowest first, with its rank and share; the picked one's numbers hour by hour beside it. */
export function PartsTab({ map, reading, ranks, coverage, trace, picked, onPick }: { map: FlowMap; reading?: FlowMapReading; ranks: ReturnType<typeof rankFlowParts>; coverage: FlowCoverage; trace: FlowTrace | null; picked: FlowPartRef | null; onPick: (p: FlowPartRef | null) => void }) {
  const { t, tn, formatNumber, locale } = useI18n()
  const rankOf = new Map(ranks.map((r, i) => [`${r.of}:${r.key}`, { rank: i + 1, share: r.share }]))
  const measuredRows = ranks.map((r) => ({ of: r.of, key: r.key, label: r.label, timing: r.timing as ReturnType<typeof rankFlowParts>[number]['timing'] | undefined, error: undefined as string | undefined }))
  const rest = flowParts(map)
    .filter((p) => !rankOf.has(`${p.of}:${p.key}`))
    .map((p) => ({ of: p.of, key: p.key, label: p.label, timing: reading?.[p.of][p.key], error: reading?.errors[p.key] }))
  const rows = [...measuredRows, ...rest]
  const noData = new Set(coverage.noData.map((p) => `${p.of}:${p.key}`))
  const unmeasured = new Set(coverage.unmeasured.map((p) => `${p.of}:${p.key}`))
  const hour = (at: number) => new Date(at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
  const pickedTiming = picked && reading ? reading[picked.of][picked.key] : undefined
  const pickedWorst = pickedTiming && pickedTiming.count > 0 ? worstHour(pickedTiming) : null
  const pickedError = picked && reading ? reading.errors[picked.key] : undefined
  const pickedHop = picked && trace ? trace.hops[picked.key] : undefined
  const pickedRank = picked ? rankOf.get(`${picked.of}:${picked.key}`) : undefined
  if (rows.length === 0) return <p className="text-sm text-muted">{t('flowMaps.noMeasures')}</p>
  return (
    <div className="grid gap-3 md:grid-cols-[1fr_minmax(300px,400px)]">
      <div className="min-w-0 overflow-x-auto">
      <table className="w-full text-xs" data-testid="flow-parts">
        <thead className="text-left text-muted">
          <tr>
            <th className="w-10 py-1 pr-2 font-medium">{t('flowMaps.rank')}</th>
            <th className="py-1 font-medium">{t('flowMaps.part')}</th>
            <th className="whitespace-nowrap py-1 pl-2 text-right font-medium">{t('flowMaps.calls')}</th>
            <th className="whitespace-nowrap py-1 pl-2 text-right font-medium">p50</th>
            <th className="whitespace-nowrap py-1 pl-2 text-right font-medium">p95</th>
            <th className={cn(WIDE, 'whitespace-nowrap py-1 pl-2 text-right font-medium')}>p99</th>
            <th className={cn(WIDE, 'whitespace-nowrap py-1 pl-2 text-right font-medium')}>{t('flowMaps.perMinute')}</th>
            <th className="whitespace-nowrap py-1 pl-2 text-right font-medium">{t('flowMaps.errors')}</th>
            <th className="whitespace-nowrap py-1 pl-2 text-right font-medium" title={t('flowMaps.vsPrevHint')}>{t('flowMaps.vsPrev')}</th>
            <th className="whitespace-nowrap py-1 pl-2 text-right font-medium" title={t('flowMaps.vsWeekHint')}>{t('flowMaps.vsWeek')}</th>
            <th className={cn(WIDE, 'whitespace-nowrap py-1 pl-2 text-right font-medium')}>{t('flowMaps.share')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const key = `${r.of}:${r.key}`
            const active = picked?.of === r.of && picked.key === r.key
            const rk = rankOf.get(key)
            return (
              <tr key={key} className={cn('cursor-pointer border-t border-border hover:bg-surface-hover', active && 'bg-accent-soft')} onClick={() => onPick(active ? null : { of: r.of, key: r.key })}>
                <td className="py-1 pr-2 tabular-nums text-muted">{rk ? (rk.rank <= 3 ? <span className="inline-flex size-4 items-center justify-center rounded-full text-[10px] font-bold text-white" style={{ background: '#f97316' }}>{rk.rank}</span> : rk.rank) : ''}</td>
                <td className={cn('py-1 pr-2', unmeasured.has(key) && 'text-muted')}>{r.label}</td>
                {r.error ? (
                  <td colSpan={9} className="py-1 text-right text-danger" title={r.error}>{t('flowMaps.failedShort')}</td>
                ) : unmeasured.has(key) ? (
                  <td colSpan={9} className="py-1 text-right text-subtle">{t('flowMaps.noMeasureShort')}</td>
                ) : noData.has(key) || !r.timing ? (
                  <td colSpan={9} className="py-1 text-right text-warning">{t('flowMaps.noData')}</td>
                ) : (
                  <>
                    <td className="whitespace-nowrap py-1 pl-2 text-right tabular-nums">{formatNumber(r.timing.count)}</td>
                    <td className="whitespace-nowrap py-1 pl-2 text-right tabular-nums">{formatMs(r.timing.p50Ms)}</td>
                    <td className="whitespace-nowrap py-1 pl-2 text-right tabular-nums">{formatMs(r.timing.p95Ms)}</td>
                    <td className={cn(WIDE, 'whitespace-nowrap py-1 pl-2 text-right tabular-nums')}>{r.timing.p99Ms !== undefined ? formatMs(r.timing.p99Ms) : '–'}</td>
                    <td className={cn(WIDE, 'whitespace-nowrap py-1 pl-2 text-right tabular-nums')}>{r.timing.perMinute !== undefined ? formatPerMinute(r.timing.perMinute) : '–'}</td>
                    <td className={cn('whitespace-nowrap py-1 pl-2 text-right tabular-nums', (r.timing.failed ?? 0) > 0 && 'text-danger')}>{errorsText(r.timing)}</td>
                    <Ratio timing={r.timing} baseline={r.timing.previous} />
                    <Ratio timing={r.timing} baseline={r.timing.weekly} />
                    <td className={cn(WIDE, 'whitespace-nowrap py-1 pl-2 text-right tabular-nums')}>{rk ? `${Math.round(rk.share * 100)} %` : '—'}</td>
                  </>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
      </div>
      <div className="min-w-0 rounded-md border border-border p-3" data-testid="flow-part-detail">
        {!picked && <p className="text-sm text-muted">{t('flowMaps.pickHint')}</p>}
        {picked && (
          <>
            <p className="mb-1 text-sm font-semibold">{flowPartLabel(map, picked)}</p>
            {pickedError && <p className="text-sm text-danger">{t('flowMaps.measureFailed', { error: pickedError })}</p>}
            {!pickedError && unmeasured.has(`${picked.of}:${picked.key}`) && <p className="text-sm text-muted">{t('flowMaps.noMeasure')}</p>}
            {!pickedError && !unmeasured.has(`${picked.of}:${picked.key}`) && !pickedTiming && <p className="text-sm text-warning">{t('flowMaps.coverage.noData.hint')}</p>}
            {pickedHop && (
              <dl className="mb-2 grid grid-cols-3 gap-2 rounded bg-accent-soft p-2 text-xs">
                <Stat label={t('flowMaps.traces.duration')} value={formatMs(pickedHop.durationMs)} />
                <Stat label={t('flowMaps.traces.when')} value={`+${formatMs(pickedHop.startMs)}`} />
                <Stat label={t('flowMaps.traces.outcome')} value={pickedHop.failed ? t('flowMaps.traces.outcome.failure') : `${tn('flowMaps.traces.times', pickedHop.count)}`} />
              </dl>
            )}
            {pickedTiming && pickedTiming.count > 0 && reading && (
              <>
                <dl className="mb-2 grid grid-cols-3 gap-2 text-xs" data-testid="flow-part-stats">
                  <Stat label="p50" value={formatMs(pickedTiming.p50Ms)} />
                  <Stat label="p95" value={formatMs(pickedTiming.p95Ms)} />
                  <Stat label="p99" value={pickedTiming.p99Ms !== undefined ? formatMs(pickedTiming.p99Ms) : '–'} />
                  <Stat label={t('flowMaps.calls')} value={formatNumber(pickedTiming.count)} />
                  <Stat label={t('flowMaps.perMinute')} value={pickedTiming.perMinute !== undefined ? formatPerMinute(pickedTiming.perMinute) : '–'} />
                  <Stat label={t('flowMaps.share')} value={pickedRank ? `${Math.round(pickedRank.share * 100)} %` : '—'} />
                  <Stat label={t('flowMaps.failed')} value={errorsText(pickedTiming)} />
                  {pickedWorst && <Stat label={t('flowMaps.worstHour')} value={`${hour(pickedWorst.at)} · ${formatMs(pickedWorst.p95Ms)}`} />}
                </dl>
                {pickedTiming.codes && pickedTiming.codes.length > 0 && (
                  <div className="mb-2 text-xs" data-testid="flow-part-codes">
                    <p className="mb-0.5 font-medium text-muted">{t('flowMaps.detail.codes')}</p>
                    <table className="w-full">
                      <tbody>
                        {pickedTiming.codes.map((c) => (
                          <tr key={c.code}>
                            <td className="py-px pr-2">{c.code}</td>
                            <td className="py-px pr-2 text-right tabular-nums">{formatNumber(c.count)}</td>
                            <td className="py-px text-right tabular-nums text-muted">{pickedTiming.count > 0 ? `${((c.count / pickedTiming.count) * 100).toFixed(1)} %` : '–'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {(pickedTiming.previous || pickedTiming.weekly) && (
                  <div className="mb-2 text-xs" data-testid="flow-part-baselines">
                    <p className="mb-0.5 font-medium text-muted">{t('flowMaps.detail.baselines')}</p>
                    <ul className="flex flex-col gap-0.5">
                      {([['flowMaps.detail.previous', pickedTiming.previous], ['flowMaps.detail.weekly', pickedTiming.weekly]] as const).map(([label, base]) => (
                        <li key={label} className="flex flex-wrap items-baseline gap-x-2">
                          <span className="text-muted">{t(label)}</span>
                          {base && base.count > 0 ? (
                            <>
                              <span className="tabular-nums">{t('flowMaps.detail.baselineLine', { p50: formatMs(base.p50Ms), p95: formatMs(base.p95Ms), calls: formatNumber(base.count), errors: base.errorRate !== undefined ? t('flowMaps.detail.baselineErrors', { rate: `${(base.errorRate * 100).toFixed(1)} %` }) : '' })}</span>
                              <span className={cn('font-semibold tabular-nums', ratioTone(ratioOf(pickedTiming, base)))}>{ratioText(ratioOf(pickedTiming, base))}</span>
                            </>
                          ) : (
                            <span className="text-subtle">{t('flowMaps.detail.noBaseline')}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <HourlyChart timing={pickedTiming} hours={reading.windowHours} />
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}

/** Columns that only show when the table has room; the detail panel always carries them. */
const WIDE = 'hidden xl:table-cell'

const formatPerMinute = (n: number) => (n >= 10 ? Math.round(n).toString() : n.toFixed(1))

/** "3 · 1.2 %": failed calls and their share; just the share when the count is unknown. */
function errorsText(timing: FlowTiming): string {
  if (timing.errorRate === undefined && timing.failed === undefined) return '–'
  const rate = timing.errorRate !== undefined ? `${(timing.errorRate * 100).toFixed(1)} %` : undefined
  return [timing.failed, rate].filter((v) => v !== undefined).join(' · ')
}

/** The window's p95 over a baseline's; undefined without a baseline to compare with. */
export function ratioOf(timing: FlowTiming, baseline: FlowBaseline | undefined): number | undefined {
  return baseline && baseline.count > 0 && baseline.p95Ms > 0 && timing.count > 0 ? timing.p95Ms / baseline.p95Ms : undefined
}
const ratioText = (r: number | undefined) => (r === undefined ? '–' : `×${r.toFixed(1)}`)
const ratioTone = (r: number | undefined) => (r === undefined || r <= 1.1 ? 'text-muted' : r <= 1.5 ? 'text-warning' : 'text-danger')

function Ratio({ timing, baseline }: { timing: FlowTiming; baseline: FlowBaseline | undefined }) {
  const r = ratioOf(timing, baseline)
  return <td className={cn('whitespace-nowrap py-1 pl-2 text-right tabular-nums', ratioTone(r))}>{ratioText(r)}</td>
}

/** Today against the part's own 7 days: the worst one or two deviations (slower, or failing more), each a button that picks the part. */
export function DeviationLine({ map, reading, onPick }: { map: FlowMap; reading: FlowMapReading; onPick: (p: FlowPartRef) => void }) {
  const { t } = useI18n()
  const worst = rankFlowDeviations(map, reading, 'weekly')
    .filter((d) => d.ratio > 1.2 || d.errorDelta > 0.02)
    .slice(0, 2)
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted" data-testid="flow-deviations">
      {worst.length === 0 && <span>{t('flowMaps.deviation.none')}</span>}
      {worst.map((d) => (
        <button key={`${d.of}:${d.key}`} type="button" className={cn('underline-offset-2 hover:underline', d.ratio > 1.5 || d.errorDelta > 0.05 ? 'text-danger' : 'text-warning')} onClick={() => onPick({ of: d.of, key: d.key })}>
          {d.ratio > 1.2 ? t('flowMaps.deviation.slow', { label: d.label, ratio: d.ratio.toFixed(1) }) : t('flowMaps.deviation.errors', { label: d.label, points: Math.round(d.errorDelta * 100) })}
        </button>
      ))}
    </div>
  )
}

const ALERT_EXAMPLE = `"alerts": {
  "p95Ms": 3000,
  "errorRate": 0.05,
  "parts": { "orders": { "p95Ms": 1500 } }
}`

/** Every measured part with its limits (the map's, or its own), its numbers in the window and whether it is above one. */
export function AlertsTab({ map, reading, onPick }: { map: FlowMap; reading?: FlowMapReading; onPick: (p: FlowPartRef) => void }) {
  const { t, formatNumber } = useI18n()
  const rows = flowMeasures(map).map((m) => {
    const timing = reading?.[m.of][m.key]
    const limits = flowThresholds(map, m)
    const hits = timing ? breaches(timing, limits) : []
    return { of: m.of, key: m.key, label: flowPartLabel(map, m), timing: timing && timing.count > 0 ? timing : undefined, limits, hits }
  })
  rows.sort((a, b) => b.hits.length - a.hits.length)
  const pct = (r: number) => `${(r * 100).toFixed(1)} %`
  const dash = '–'
  return (
    <div className="flex flex-col gap-3" data-testid="flow-alerts">
      {!hasFlowAlerts(map) && (
        <div className="flex flex-col gap-1.5 text-xs text-muted">
          <p>{t('flowMaps.alerts.noneConfigured')}</p>
          <pre className="overflow-x-auto rounded-md border border-border bg-surface-raised p-2 text-[11px] text-text">{ALERT_EXAMPLE}</pre>
        </div>
      )}
      <p className="text-xs text-subtle">
        {t('flowMaps.alerts.notify')}
        {reading ? ` ${t('flowMaps.alerts.window', { hours: reading.windowHours })}` : ''}
      </p>
      {rows.length === 0 ? (
        <p className="text-sm text-muted">{t('flowMaps.noMeasures')}</p>
      ) : (
        <table className="w-full text-xs" data-testid="flow-alerts-table">
          <thead className="text-left text-muted">
            <tr>
              <th className="py-1 pr-2 font-medium">{t('flowMaps.part')}</th>
              <th className="whitespace-nowrap py-1 pl-2 text-right font-medium">{t('flowMaps.alerts.p95Limit')}</th>
              <th className="whitespace-nowrap py-1 pl-2 text-right font-medium">{t('flowMaps.alerts.errorLimit')}</th>
              <th className="whitespace-nowrap py-1 pl-2 text-right font-medium">{t('flowMaps.alerts.p95Now')}</th>
              <th className="whitespace-nowrap py-1 pl-2 text-right font-medium">{t('flowMaps.alerts.errorNow')}</th>
              <th className="whitespace-nowrap py-1 pl-2 text-right font-medium">{t('flowMaps.alerts.status')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const slow = r.hits.some((h) => h.kind === 'flowSlow')
              const failing = r.hits.some((h) => h.kind === 'flowErrors')
              const limited = r.limits.p95Ms !== undefined || r.limits.errorRate !== undefined
              return (
                <tr key={`${r.of}:${r.key}`} className="cursor-pointer border-t border-border hover:bg-surface-hover" onClick={() => onPick({ of: r.of, key: r.key })}>
                  <td className="py-1 pr-2">{r.label}</td>
                  <td className="whitespace-nowrap py-1 pl-2 text-right tabular-nums">{r.limits.p95Ms !== undefined ? formatMs(r.limits.p95Ms) : dash}</td>
                  <td className="whitespace-nowrap py-1 pl-2 text-right tabular-nums">{r.limits.errorRate !== undefined ? pct(r.limits.errorRate) : dash}</td>
                  <td className={cn('whitespace-nowrap py-1 pl-2 text-right tabular-nums', slow && 'font-semibold text-danger')}>{r.timing ? formatMs(r.timing.p95Ms) : dash}</td>
                  <td className={cn('whitespace-nowrap py-1 pl-2 text-right tabular-nums', failing && 'font-semibold text-danger')} title={r.timing?.failed !== undefined ? formatNumber(r.timing.failed) : undefined}>{r.timing?.errorRate !== undefined ? pct(r.timing.errorRate) : dash}</td>
                  <td className="whitespace-nowrap py-1 pl-2 text-right">
                    {!r.timing ? (
                      <span className="text-subtle">{t('flowMaps.alerts.noData')}</span>
                    ) : r.hits.length > 0 ? (
                      <span className="rounded bg-danger/15 px-1.5 py-px font-medium text-danger">{t('flowMaps.alerts.above')}</span>
                    ) : limited ? (
                      <span className="rounded bg-success/15 px-1.5 py-px font-medium text-success">{t('flowMaps.alerts.ok')}</span>
                    ) : (
                      <span className="text-subtle">{dash}</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}

function CoverageTab({ coverage, onPick }: { coverage: FlowCoverage; onPick: (p: FlowPartRef) => void }) {
  const { t } = useI18n()
  const group = (title: string, hint: string | undefined, items: (FlowPartRef & { label: string; error?: string })[], tone: string) =>
    items.length > 0 && (
      <section className="flex flex-col gap-1">
        <h3 className={cn('text-sm font-semibold', tone)}>{title}</h3>
        {hint && <p className="text-xs text-subtle">{hint}</p>}
        <ul className="flex flex-wrap gap-1.5">
          {items.map((p) => (
            <li key={`${p.of}:${p.key}`}>
              <button type="button" className="rounded-md border border-border bg-surface px-2 py-0.5 text-xs hover:bg-surface-hover" title={p.error} onClick={() => onPick({ of: p.of, key: p.key })}>
                {p.label}
                {p.error ? ` · ${p.error}` : ''}
              </button>
            </li>
          ))}
        </ul>
      </section>
    )
  const nothing = coverage.unmeasured.length + coverage.noData.length + coverage.failed.length === 0
  return (
    <div className="flex flex-col gap-4" data-testid="flow-coverage">
      {nothing && <p className="text-sm text-success">{t('flowMaps.coverage.allGood')}</p>}
      {group(t('flowMaps.coverage.noData.title'), t('flowMaps.coverage.noData.hint'), coverage.noData, 'text-warning')}
      {group(t('flowMaps.coverage.unmeasured.title'), t('flowMaps.coverage.unmeasured.hint'), coverage.unmeasured, 'text-text')}
      {group(t('flowMaps.coverage.failed.title'), undefined, coverage.failed, 'text-danger')}
    </div>
  )
}

function Legend() {
  const { t } = useI18n()
  const kinds = Object.keys(KIND_COLOR) as FlowNodeKind[]
  return (
    <div className="grid gap-3 text-xs md:grid-cols-2" data-testid="flow-legend">
      <div className="flex flex-col gap-1.5">
        <p className="font-medium text-text">{t('flowMaps.legend.kinds')}</p>
        <ul className="flex flex-wrap gap-x-3 gap-y-1">
          {kinds.map((k) => (
            <li key={k} className="inline-flex items-center gap-1.5 text-muted">
              <span className="inline-block size-3 rounded-sm border-2" style={{ borderColor: KIND_COLOR[k] }} aria-hidden /> {t(`flowMaps.legend.kind.${k}`)}
            </li>
          ))}
        </ul>
        <ul className="mt-1 flex flex-col gap-1 text-muted">
          <li className="inline-flex items-center gap-2"><span className="inline-block h-0.5 w-6 bg-[#64748b]" aria-hidden /> {t('flowMaps.legend.sync')}</li>
          <li className="inline-flex items-center gap-2"><span className="inline-block h-0 w-6 border-t-2 border-dashed border-[#64748b]" aria-hidden /> {t('flowMaps.legend.async')}</li>
          <li className="inline-flex items-center gap-2"><span className="inline-block h-0 w-6 border-t-2 border-dotted" style={{ borderColor: WAIT }} aria-hidden /> {t('flowMaps.legend.wait')}</li>
        </ul>
      </div>
      <ul className="flex flex-col gap-1.5 text-muted">
        <li>{t('flowMaps.legend.numbers')}</li>
        <li>{t('flowMaps.legend.heat')}</li>
        <li>{t('flowMaps.legend.unmeasured')}</li>
        <li>{t('flowMaps.legend.noData')}</li>
        <li>{t('flowMaps.legend.picked')}</li>
      </ul>
    </div>
  )
}
