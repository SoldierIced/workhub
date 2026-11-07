import { AppWindow, ChevronLeft, ChevronRight, Copy, ListOrdered, Maximize2, MoreHorizontal, Pause, Play, RotateCcw, Sparkles, Waypoints, X, ZoomIn, ZoomOut } from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { breaches, flowAlertsOf, flowCoverage, flowMeasures, flowPartLabel, flowParts, flowThresholds, formatMs, hasFlowAlerts, layoutFlowMap, rankFlowDeviations, rankFlowParts, slowShareOf, type FlowBaseline, type FlowLimits, type FlowCoverage, type FlowMap, type FlowMapReading, type FlowNodeKind, type FlowPartDeviation, type FlowPartRef, type FlowTiming, type FlowTrace, type FlowTraceSort } from '@workhub/core'
import type { FlowMapResult, FlowTraceLogsResult, FlowTraceResult, HealthEnvironmentView } from '@shared/health-api'
import { Badge, Button, IconButton, Spinner } from '../../components/atoms'
import { Tabs, useToast } from '../../components/molecules'
import { useI18n } from '../../i18n/I18nProvider'
import { cn } from '../../lib/cn'
import { errorText } from '../../lib/errorText'
import { readPrefs, setPrefs } from '../../lib/prefs'
import { pressable } from '../../lib/pressable'
import { FlowMapSvg, flowMapToPng, KIND_COLOR, WAIT } from './FlowMapSvg'
import { FlowSequenceSvg, sequenceFitWidth, sequenceLayout } from './FlowSequenceSvg'
import { flowMapPrompt } from './flowMapPrompt'
import { HourlyChart } from './HourlyChart'
import { Segmented } from './Segmented'
import { TracesPanel } from './TracesPanel'

const WINDOWS = [6, 24, 72, 168]
const ZOOM_STEPS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2]
/** Below this width of the view the detail drawer starts folded, so the diagram keeps its room. */
const DRAWER_ROOM = 1200
/** The diagram box: never shorter than this, never taller than this share of the window. */
const DIAGRAM_MIN_HEIGHT = 420
const DIAGRAM_MAX_VH = 0.75
type Tab = 'parts' | 'executions' | 'coverage' | 'alerts' | 'legend'
type Ranks = ReturnType<typeof rankFlowParts>

export interface FlowMapViewProps {
  /** The Health environment the numbers come from; null while Health is off (the map is drawn without numbers). */
  env: HealthEnvironmentView | null
  profileId: string | null
  mapId: string
  /** The map's file, named in the Claude draft so the session can edit it. */
  file?: string
  /** Main window: opens a Claude session with the draft. Absent in the map window, which asks the main window instead. */
  onAsk?: (draft: string, folder: string | undefined) => void
  /** Opens a Settings tab (`flowMaps`, `health`); absent in the map window, which hides those links. */
  onOpenSettings?: (tab?: string) => void
  /** Whether "Open in a window" shows (not inside the window itself). */
  canOpenWindow?: boolean
}

/**
 * One map: a header row (window, Diagram/Sequence, animation, fit, more, Ask Claude, refresh), four
 * verdict tiles (coverage, slowest part, alerts, against the usual), the diagram with the picked
 * part's detail in a drawer beside it, and the tabs under them: the parts, the real executions,
 * the coverage, the alerts and the legend.
 */
export function FlowMapView({ env, profileId, mapId, file, onAsk, onOpenSettings, canOpenWindow = true }: FlowMapViewProps) {
  const { t, locale } = useI18n()
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
  const [collapsed, setCollapsed] = useState(() => readPrefs().flowMapDrawerCollapsed)
  const root = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const envId = env?.id ?? ''

  // A narrow view starts with the drawer folded; the remembered choice applies when there is room.
  useLayoutEffect(() => {
    const width = root.current?.clientWidth ?? Infinity
    if (width > 0 && width < DRAWER_ROOM) setCollapsed(true)
  }, [])
  const toggleDrawer = () => {
    setCollapsed((c) => {
      setPrefs({ flowMapDrawerCollapsed: !c })
      return !c
    })
  }

  const asked = useRef(0)
  // The stored reading draws the map at once; the fresh one (only the hours not stored yet) replaces it.
  // Without an environment (Health off) only the map itself is asked for.
  const load = (force = false) => {
    const ask = ++asked.current
    let fresh = false
    setLoading(true)
    if (!force && env) {
      window.hub.health
        .flowMap(profileId, envId, mapId, hours, false, true)
        .then((stored) => {
          if (ask === asked.current && !fresh && stored.ok) setResult(stored)
        })
        .catch(() => undefined)
    }
    window.hub.health
      .flowMap(profileId, envId, mapId, hours, force, !env)
      .then((r) => {
        fresh = true
        if (ask !== asked.current) return
        // A failed read keeps what is stored on screen and says why it is not newer.
        setResult((prev) => {
          if (r.ok || !prev?.ok || !prev.reading) return r
          toast(t('flowMaps.staleReading', { error: r.error }), 'danger')
          return prev
        })
      })
      .catch((e: unknown) => ask === asked.current && setResult({ ok: false, error: errorText(e) }))
      .finally(() => ask === asked.current && setLoading(false))
  }
  useEffect(() => void load(), [profileId, envId, mapId, hours]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!traceId || !env) return setTrace(null)
    let alive = true
    setLoadingTrace(true)
    window.hub.health
      .flowTrace(profileId, envId, mapId, traceId)
      .then((r) => alive && setTrace(r))
      .catch((e: unknown) => alive && setTrace({ ok: false, error: errorText(e) }))
      .finally(() => alive && setLoadingTrace(false))
    return () => {
      alive = false
    }
  }, [profileId, envId, mapId, traceId]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setLogs(null)
    if (!traceId || !env) return setLoadingLogs(false)
    let alive = true
    setLoadingLogs(true)
    window.hub.health
      .flowTraceLogs(profileId, envId, mapId, traceId)
      .then((r) => alive && setLogs(r))
      .catch((e: unknown) => alive && setLogs({ ok: false, error: errorText(e) }))
      .finally(() => alive && setLoadingLogs(false))
    return () => {
      alive = false
    }
  }, [profileId, envId, mapId, traceId]) // eslint-disable-line react-hooks/exhaustive-deps

  const map = result?.ok ? result.map : null
  const reading = result?.ok ? result.reading : undefined
  const layout = useMemo(() => (map ? layoutFlowMap(map) : null), [map])
  const ranks = useMemo(() => (map && reading ? rankFlowParts(map, reading) : []), [map, reading])
  const coverage = useMemo(() => (map ? flowCoverage(map, reading) : null), [map, reading])
  const selectedTrace: FlowTrace | null = trace?.ok ? trace.trace : null
  const sequence = useMemo(() => (map ? sequenceLayout(map, selectedTrace) : null), [map, selectedTrace])
  // Both views fit their width; a sequence of many services fits its first lifelines and scrolls for the rest.
  const fitWidth = view === 'sequence' && sequence ? sequenceFitWidth(sequence) : (layout?.width ?? 1)
  const breached = useMemo(() => (map && reading ? new Set(flowAlertsOf(map, reading, { id: envId, name: env?.name ?? '' }).map((a) => `${a.part.of}:${a.part.key}`)).size : 0), [map, reading, envId, env?.name])
  const gaps = coverage ? coverage.unmeasured.length + coverage.noData.length + coverage.failed.length : 0

  const fitHeight = view === 'sequence' && sequence ? sequence.height : (layout?.height ?? 1)
  // Fit: the diagram's natural size against the scroller's width and its tallest allowed height, measured again
  // when the scroller resizes (the drawer folding, the window). Fitting the height too keeps the fitted picture
  // from overflowing, which would add a scrollbar, narrow the scroller and refit it in a loop; tiny width
  // changes (a scrollbar appearing elsewhere) are ignored for the same reason.
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el || !layout) return
    const measure = () => {
      const width = el.clientWidth - 2
      const height = Math.max(DIAGRAM_MIN_HEIGHT, window.innerHeight * DIAGRAM_MAX_VH) - 2
      const next = Math.min(1.5, Math.max(0.3, Math.min(width / fitWidth, height / fitHeight)))
      setFitScale((prev) => (Math.abs(prev - next) < 0.01 ? prev : next))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    window.addEventListener('resize', measure)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [layout, fitWidth, fitHeight])
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
  const ask = (focus: FlowPartRef | null = null) => {
    if (!map) return
    const draft = flowMapPrompt((k, p) => t(k, p), { map, file: file ?? `${mapId}.json`, environment: env?.name ?? '—', reading, trace: selectedTrace, logs: logs?.ok ? logs.logs : null, focus, locale })
    if (onAsk) onAsk(draft, undefined)
    else window.hub.flowMaps.ask(draft)
  }
  const turnOnHealth = !env && onOpenSettings ? () => onOpenSettings('health') : undefined

  let body: ReactNode
  if (!result) body = <p className="flex items-center gap-2 text-sm text-muted"><Spinner /> {t('flowMaps.loading')}</p>
  else if (!result.ok || !map || !layout || !coverage) {
    // Without Health there may be nothing to draw yet: say what brings the map, not the raw reason.
    body = !env ? (
      <p className="rounded-md border border-border bg-surface px-3 py-2 text-sm text-muted" data-testid="flow-map-health-off">
        {t('flowMaps.healthOff.noMap')}{' '}
        {turnOnHealth && <button type="button" className="text-accent underline-offset-2 hover:underline" onClick={turnOnHealth}>{t('flowMaps.tile.turnOnHealth')}</button>}
      </p>
    ) : (
      <p className="text-sm text-danger">{result.ok ? '' : result.error}</p>
    )
  } else {
    const menu = [
      { key: 'in', label: t('flowMaps.zoomIn'), icon: <ZoomIn className="size-3.5" aria-hidden />, onSelect: () => step(1) },
      { key: 'out', label: t('flowMaps.zoomOut'), icon: <ZoomOut className="size-3.5" aria-hidden />, onSelect: () => step(-1) },
      { key: 'copy', label: t('flowMaps.copyImage'), icon: <Copy className="size-3.5" aria-hidden />, onSelect: () => void copyImage() },
      ...(canOpenWindow && env ? [{ key: 'window', label: t('flowMaps.openWindow'), icon: <AppWindow className="size-3.5" aria-hidden />, onSelect: () => window.hub.flowMaps.openWindow(profileId, envId, mapId) }] : [])
    ]
    body = (
      <>
        <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="flow-map-header">
          <span className="shrink-0 font-semibold">{map.name}</span>
          <span className="min-w-0 flex-1 basis-0 truncate text-muted" title={map.description}>{map.description}</span>
          {env && <Segmented label={t('flowMaps.window')} value={hours} onChange={setHours} options={WINDOWS.map((h) => ({ value: h, label: h < 24 ? `${h} h` : `${h / 24} d` }))} />}
          <Segmented
            label={t('flowMaps.view')}
            value={view}
            onChange={(v) => {
              setView(v)
              setZoom('fit')
            }}
            options={[
              { value: 'map', label: t('flowMaps.view.map'), icon: <Waypoints className="size-3.5" aria-hidden /> },
              { value: 'sequence', label: t('flowMaps.view.sequence'), icon: <ListOrdered className="size-3.5" aria-hidden /> }
            ]}
          />
          <div className="flex shrink-0 items-center">
            <IconButton size="sm" label={flow ? t('flowMaps.animate.pause') : t('flowMaps.animate.play')} aria-pressed={flow} icon={flow ? <Pause className="size-3.5" aria-hidden /> : <Play className="size-3.5" aria-hidden />} onClick={() => setFlow(!flow)} />
            <IconButton size="sm" label={t('flowMaps.zoomFit')} aria-pressed={zoom === 'fit'} icon={<Maximize2 className="size-3.5" aria-hidden />} onClick={() => setZoom('fit')} />
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <IconButton size="sm" label={t('flowMaps.more')} icon={<MoreHorizontal className="size-3.5" aria-hidden />} data-testid="flow-map-more" />
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content align="end" sideOffset={6} className="z-50 min-w-48 animate-fade-in rounded-md border border-border bg-surface-raised p-1 shadow-lg">
                  {menu.map((m) => (
                    <DropdownMenu.Item key={m.key} onSelect={m.onSelect} className="flex h-8 cursor-default select-none items-center gap-2 rounded-sm px-2 text-base outline-none data-[highlighted]:bg-accent-soft">
                      {m.icon}
                      {m.label}
                    </DropdownMenu.Item>
                  ))}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
          <Button size="sm" variant="ghost" icon={<Sparkles className="size-3.5" aria-hidden />} title={t('flowMaps.askHint')} onClick={() => ask()}>
            {t('flowMaps.ask')}
          </Button>
          {env && <IconButton size="sm" label={t('flowMaps.refresh')} icon={loading ? <Spinner /> : <RotateCcw className="size-3.5" aria-hidden />} disabled={loading} onClick={() => load(true)} />}
        </div>

        <VerdictStrip map={map} reading={reading} coverage={coverage} ranks={ranks} breached={breached} onTab={setTab} onPick={setPicked} onTurnOnHealth={turnOnHealth} healthOff={!env} />

        {selectedTrace && (
          <div className="flex items-center gap-2 rounded-md border border-accent/40 bg-accent-soft px-3 py-1.5 text-xs" data-testid="flow-trace-banner">
            <span className="font-medium">{t('flowMaps.traces.selected', { when: new Date(selectedTrace.at).toLocaleString(locale), duration: formatMs(selectedTrace.durationMs) })}</span>
            <span className="flex-1" />
            <Button size="sm" variant="ghost" icon={<X className="size-3.5" aria-hidden />} onClick={() => setTraceId(null)}>
              {t('flowMaps.traces.clear')}
            </Button>
          </div>
        )}

        <div className="flex items-start gap-3">
          <div ref={scroller} className="flex min-w-0 flex-1 overflow-auto rounded-md border border-border bg-bg" style={{ minHeight: DIAGRAM_MIN_HEIGHT, maxHeight: `${DIAGRAM_MAX_VH * 100}vh`, scrollbarGutter: 'stable' }} data-testid="flow-map-diagram">
            <div className="m-auto w-max">
              {view === 'map' ? (
                <FlowMapSvg svgRef={svgRef} map={map} reading={reading} trace={selectedTrace} flow={flow} picked={picked} onPick={setPicked} ranks={ranks} coverage={coverage} scale={scale} />
              ) : (
                <FlowSequenceSvg svgRef={svgRef} map={map} reading={reading} trace={selectedTrace} flow={flow} picked={picked} onPick={setPicked} ranks={ranks} coverage={coverage} scale={scale} />
              )}
            </div>
          </div>
          <PartDrawer
            map={map}
            reading={reading}
            ranks={ranks}
            coverage={coverage}
            trace={selectedTrace}
            picked={picked}
            collapsed={collapsed}
            onToggle={toggleDrawer}
            onAdjust={onOpenSettings ? () => onOpenSettings('flowMaps') : undefined}
            onTurnOnHealth={turnOnHealth}
            onInvestigate={(p) => ask(p)}
          />
        </div>

        <Tabs
          label={map.name}
          value={tab}
          onChange={(v) => setTab(v as Tab)}
          items={[
            { value: 'parts', label: t('flowMaps.tab.parts'), content: <PartsTab map={map} reading={reading} ranks={ranks} coverage={coverage} picked={picked} onPick={setPicked} /> },
            ...(env
              ? [
                  {
                    value: 'executions',
                    label: t('flowMaps.tab.executions'),
                    content: (
                      <TracesPanel
                        map={map}
                        hours={hours}
                        list={(sort: FlowTraceSort) => window.hub.health.flowTraces(profileId, envId, mapId, hours, sort)}
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
                  }
                ]
              : []),
            { value: 'coverage', label: gaps > 0 ? t('flowMaps.tab.coverageCount', { count: gaps }) : t('flowMaps.tab.coverage'), content: <CoverageTab coverage={coverage} onPick={setPicked} /> },
            { value: 'alerts', label: breached > 0 ? t('flowMaps.tab.alertsCount', { count: breached }) : t('flowMaps.tab.alerts'), content: <AlertsTab map={map} reading={reading} onPick={setPicked} onAdjust={onOpenSettings ? () => onOpenSettings('flowMaps') : undefined} /> },
            { value: 'legend', label: t('flowMaps.tab.legend'), content: <Legend /> }
          ]}
          contentClassName="pt-3"
        />
      </>
    )
  }

  return (
    <div ref={root} className="flex min-w-0 flex-col gap-3" data-testid="flow-map-view">
      {body}
    </div>
  )
}

/** The deviations worth naming: slower than 1.2 times the 7-day usual, or failing two points more. */
export function notableDeviations(map: FlowMap, reading: FlowMapReading): FlowPartDeviation[] {
  return rankFlowDeviations(map, reading, 'weekly').filter((d) => d.ratio > 1.2 || d.errorDelta > 0.02)
}
const severe = (d: FlowPartDeviation) => d.ratio > 1.5 || d.errorDelta > 0.05

type TileTone = 'neutral' | 'warning' | 'danger'
const TILE_BORDER: Record<TileTone, string> = { neutral: 'border-border', warning: 'border-warning/60', danger: 'border-danger/70' }
const LINK = 'max-w-full truncate text-left underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none'

function Tile({ label, value, caption, tone = 'neutral', testId }: { label: string; value: ReactNode; caption?: ReactNode; tone?: TileTone; testId: string }) {
  return (
    <section aria-label={label} className={cn('flex min-w-0 flex-col gap-0.5 rounded-lg border bg-surface px-3 py-2', TILE_BORDER[tone])} data-testid={testId} data-tone={tone}>
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted">{label}</span>
      <span className="flex min-w-0 text-sm font-semibold">{value}</span>
      {caption && <span className="flex min-w-0 text-xs text-muted">{caption}</span>}
    </section>
  )
}

export interface VerdictStripProps {
  map: FlowMap
  reading?: FlowMapReading
  coverage: FlowCoverage
  ranks: Ranks
  /** Parts over their limits in the window. */
  breached: number
  onTab: (tab: Tab) => void
  onPick: (p: FlowPartRef) => void
  /** Health is off: the tiles say so (and link to Settings → Health when this is set). */
  healthOff?: boolean
  onTurnOnHealth?: () => void
}

/** The verdict in four tiles: how much is measured, the slowest part, the parts over their limits, and the deviations from the usual. */
export function VerdictStrip({ map, reading, coverage, ranks, breached, onTab, onPick, healthOff = false, onTurnOnHealth }: VerdictStripProps) {
  const { t, tn } = useI18n()
  const pct = (r: number) => `${Math.round(r * 100)} %`
  const gaps = [
    coverage.unmeasured.length > 0 ? tn('flowMaps.summary.unmeasured', coverage.unmeasured.length) : null,
    coverage.noData.length > 0 ? tn('flowMaps.summary.noData', coverage.noData.length) : null,
    coverage.failed.length > 0 ? tn('flowMaps.summary.failed', coverage.failed.length) : null
  ].filter((g): g is string => g !== null)
  const coverageTone: TileTone = coverage.failed.length > 0 ? 'danger' : coverage.noData.length > 0 ? 'warning' : 'neutral'
  const noNumbers = (
    <>
      {t('flowMaps.tile.noNumbers')}
      {onTurnOnHealth && (
        <>
          {' · '}
          <button type="button" className={cn(LINK, 'text-accent')} onClick={onTurnOnHealth}>{t('flowMaps.tile.turnOnHealth')}</button>
        </>
      )}
    </>
  )
  const coverageTile = (
    <Tile
      testId="flow-tile-coverage"
      label={t('flowMaps.tile.coverage')}
      tone={coverageTone}
      value={t('flowMaps.tile.coverageValue', { measured: coverage.measured, total: coverage.total })}
      caption={gaps.length > 0 ? <button type="button" className={LINK} onClick={() => onTab('coverage')}>{`${gaps.join(' · ')} →`}</button> : t('flowMaps.tile.coverageAll')}
    />
  )
  if (healthOff || !reading) {
    const off = healthOff ? <span className="truncate font-normal text-muted">{noNumbers}</span> : <span className="truncate font-normal text-muted">{t('flowMaps.summary.noNumbers')}</span>
    return (
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4" data-testid="flow-verdict">
        {coverageTile}
        <Tile testId="flow-tile-slowest" label={t('flowMaps.tile.slowest')} value={off} />
        <Tile testId="flow-tile-alerts" label={t('flowMaps.tile.alerts')} value={off} />
        <Tile testId="flow-tile-usual" label={t('flowMaps.tile.usual')} value={off} />
      </div>
    )
  }
  const slowest = ranks[0]
  const deviations = notableDeviations(map, reading)
  const top = deviations[0]
  const limits = hasFlowAlerts(map)
  return (
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-4" data-testid="flow-verdict">
      {coverageTile}
      <Tile
        testId="flow-tile-slowest"
        label={t('flowMaps.tile.slowest')}
        value={slowest ? <button type="button" className={LINK} onClick={() => onPick({ of: slowest.of, key: slowest.key })}>{slowest.label}</button> : <span className="font-normal text-muted">{t('flowMaps.summary.noNumbers')}</span>}
        caption={slowest ? t('flowMaps.tile.slowestCaption', { p95: formatMs(slowest.timing.p95Ms), share: pct(slowest.share) }) : undefined}
      />
      <Tile
        testId="flow-tile-alerts"
        label={t('flowMaps.tile.alerts')}
        tone={breached > 0 ? 'danger' : 'neutral'}
        value={
          <button type="button" className={cn(LINK, breached > 0 && 'text-danger')} onClick={() => onTab('alerts')}>
            {breached > 0 ? tn('flowMaps.tile.over', breached) : limits ? t('flowMaps.tile.withinLimits') : t('flowMaps.tile.noLimits')}
          </button>
        }
        caption={t('flowMaps.tile.alertsCaption', { hours: reading.windowHours })}
      />
      <Tile
        testId="flow-tile-usual"
        label={t('flowMaps.tile.usual')}
        tone={top ? (severe(top) ? 'danger' : 'warning') : 'neutral'}
        value={deviations.length > 0 ? tn('flowMaps.tile.deviations', deviations.length) : t('flowMaps.tile.usualNone')}
        caption={
          top ? (
            <button type="button" className={cn(LINK, severe(top) ? 'text-danger' : 'text-warning')} onClick={() => onPick({ of: top.of, key: top.key })}>
              {top.ratio > 1.2 ? t('flowMaps.deviation.slow', { label: top.label, ratio: top.ratio.toFixed(1) }) : t('flowMaps.deviation.errors', { label: top.label, points: Math.round(top.errorDelta * 100) })}
            </button>
          ) : (
            t('flowMaps.deviation.none')
          )
        }
      />
    </div>
  )
}

function Stat({ label, value, title, className }: { label: string; value: string; title?: string; className?: string }) {
  return (
    <div className="min-w-0" title={title}>
      <dt className="text-muted">{label}</dt>
      <dd className={cn('truncate font-semibold tabular-nums', className)}>{value}</dd>
    </div>
  )
}

export interface PartDrawerProps {
  map: FlowMap
  reading?: FlowMapReading
  ranks: Ranks
  coverage: FlowCoverage
  trace: FlowTrace | null
  picked: FlowPartRef | null
  collapsed: boolean
  onToggle: () => void
  /** Opens Settings → Flow maps, where the map's limits are looked after. */
  onAdjust?: () => void
  /** Health is off: the drawer links to Settings → Health instead of showing numbers. */
  onTurnOnHealth?: () => void
  /** "Investigate this part": the Claude draft, focused on it. */
  onInvestigate: (part: FlowPartRef) => void
}

/** The picked part beside the diagram: what it is, where it ranks, its numbers, hour by hour, its results and its limits. */
export function PartDrawer({ map, reading, ranks, coverage, trace, picked, collapsed, onToggle, onAdjust, onTurnOnHealth, onInvestigate }: PartDrawerProps) {
  const { t, tn, formatNumber } = useI18n()
  const toggle = (
    <IconButton
      size="sm"
      label={collapsed ? t('flowMaps.drawer.expand') : t('flowMaps.drawer.collapse')}
      aria-expanded={!collapsed}
      icon={collapsed ? <ChevronLeft className="size-3.5" aria-hidden /> : <ChevronRight className="size-3.5" aria-hidden />}
      onClick={onToggle}
    />
  )
  if (collapsed) {
    return (
      <aside aria-label={t('flowMaps.drawer.title')} className="flex w-9 shrink-0 flex-col items-center rounded-md border border-border bg-surface py-1" data-testid="flow-part-detail" data-collapsed="">
        {toggle}
      </aside>
    )
  }
  const key = picked ? `${picked.of}:${picked.key}` : ''
  const rankIndex = picked ? ranks.findIndex((r) => r.of === picked.of && r.key === picked.key) : -1
  const rank = rankIndex >= 0 ? ranks[rankIndex] : undefined
  const timing = picked && reading ? reading[picked.of][picked.key] : undefined
  const error = picked && reading ? reading.errors[picked.key] : undefined
  const hop = picked && trace ? trace.hops[picked.key] : undefined
  const unmeasured = coverage.unmeasured.some((p) => `${p.of}:${p.key}` === key)
  const measured = picked ? flowMeasures(map).some((m) => m.of === picked.of && m.key === picked.key) : false
  const limits = picked ? flowThresholds(map, picked) : {}
  const hits = timing ? breaches(timing, limits) : []
  const pct = (r: number) => `${(r * 100).toFixed(1)} %`
  const kind = !picked ? '' : picked.of === 'nodes' ? t(`flowMaps.legend.kind.${map.nodes.find((n) => n.id === picked.key)?.kind ?? 'service'}`) : picked.of === 'stages' ? t('flowMaps.drawer.kind.stage') : t('flowMaps.drawer.kind.edge')
  const baseline = (base: FlowBaseline | undefined) =>
    base && base.count > 0 ? t('flowMaps.detail.baselineLine', { p50: formatMs(base.p50Ms), p95: formatMs(base.p95Ms), calls: formatNumber(base.count), errors: base.errorRate !== undefined ? t('flowMaps.detail.baselineErrors', { rate: pct(base.errorRate) }) : '' }) : t('flowMaps.detail.noBaseline')
  return (
    <aside aria-label={t('flowMaps.drawer.title')} className="flex w-[300px] shrink-0 flex-col gap-3 overflow-y-auto rounded-md border border-border bg-surface p-3" style={{ maxHeight: '75vh' }} data-testid="flow-part-detail">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          {picked ? (
            <>
              <p className="flex flex-wrap items-center gap-1.5">
                <span className="min-w-0 break-words text-sm font-semibold">{flowPartLabel(map, picked)}</span>
                <Badge>{kind}</Badge>
              </p>
              {rank && <p className="mt-0.5 text-xs text-muted">{t('flowMaps.drawer.rank', { rank: rankIndex + 1, total: ranks.length, share: `${Math.round(rank.share * 100)} %` })}</p>}
            </>
          ) : (
            <p className="text-sm text-muted">{t('flowMaps.pickHint')}</p>
          )}
        </div>
        {toggle}
      </div>
      {picked && (
        <>
          {!reading && (
            <p className="text-xs text-muted">
              {measured ? t('flowMaps.tile.noNumbers') : t('flowMaps.noMeasure')}
              {measured && onTurnOnHealth && (
                <>
                  {' · '}
                  <button type="button" className={cn(LINK, 'text-accent')} onClick={onTurnOnHealth}>{t('flowMaps.tile.turnOnHealth')}</button>
                </>
              )}
            </p>
          )}
          {reading && error && <p className="text-sm text-danger">{t('flowMaps.measureFailed', { error })}</p>}
          {reading && !error && unmeasured && <p className="text-xs text-muted">{t('flowMaps.noMeasure')}</p>}
          {reading && !error && !unmeasured && (!timing || timing.count === 0) && <p className="text-xs text-warning">{t('flowMaps.coverage.noData.hint')}</p>}
          {hop && (
            <dl className="grid grid-cols-3 gap-2 rounded bg-accent-soft p-2 text-xs">
              <Stat label={t('flowMaps.traces.duration')} value={formatMs(hop.durationMs)} />
              <Stat label={t('flowMaps.traces.when')} value={`+${formatMs(hop.startMs)}`} />
              <Stat label={t('flowMaps.traces.outcome')} value={hop.failed ? t('flowMaps.traces.outcome.failure') : tn('flowMaps.traces.times', hop.count)} />
            </dl>
          )}
          {timing && timing.count > 0 && reading && (
            <>
              <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs" data-testid="flow-part-stats">
                <Stat label={t('flowMaps.calls')} value={formatNumber(timing.count)} />
                <Stat label={t('flowMaps.drawer.p50p95')} value={`${formatMs(timing.p50Ms)} / ${formatMs(timing.p95Ms)}`} title={timing.p99Ms !== undefined ? `p99 ${formatMs(timing.p99Ms)}` : undefined} />
                <Stat label={t('flowMaps.drawer.failures')} value={errorsText(timing)} className={(timing.failed ?? 0) > 0 ? 'text-danger' : undefined} />
                <Stat label={t('flowMaps.drawer.perMinute')} value={timing.perMinute !== undefined ? formatPerMinute(timing.perMinute) : '–'} />
                <Stat label={t('flowMaps.drawer.vsPrev')} value={ratioText(ratioOf(timing, timing.previous))} className={ratioTone(ratioOf(timing, timing.previous))} title={`${t('flowMaps.detail.previous')}: ${baseline(timing.previous)}`} />
                <Stat label={t('flowMaps.drawer.vsWeek')} value={ratioText(ratioOf(timing, timing.weekly))} className={ratioTone(ratioOf(timing, timing.weekly))} title={`${t('flowMaps.detail.weekly')}: ${baseline(timing.weekly)}`} />
              </dl>
              <HourlyChart timing={timing} hours={reading.windowHours} />
              {timing.codes && timing.codes.length > 0 && (
                <div className="text-xs" data-testid="flow-part-codes">
                  <p className="mb-1 font-medium text-muted">{t('flowMaps.detail.codes')}</p>
                  <ul className="flex flex-wrap gap-1">
                    {timing.codes.map((c) => (
                      <li key={c.code}>
                        <Badge title={formatNumber(c.count)}>{`${c.code} · ${pct(c.count / timing.count)}`}</Badge>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
          {measured && (
            <div className="text-xs" data-testid="flow-part-limits">
              <p className="mb-1 flex items-center gap-2 font-medium text-muted">
                {t('flowMaps.drawer.limits')}
                {onAdjust && <button type="button" className={cn(LINK, 'font-normal text-accent')} onClick={onAdjust}>{t('flowMaps.drawer.adjust')}</button>}
              </p>
              {limits.p95Ms === undefined && limits.errorRate === undefined && limits.slowMs === undefined ? (
                <p className="text-subtle">{t('flowMaps.drawer.noLimits')}</p>
              ) : (
                <ul className="flex flex-col gap-0.5">
                  {limits.p95Ms !== undefined && (
                    <li className="flex items-center gap-2">
                      {t('flowMaps.drawer.limitP95', { value: formatMs(limits.p95Ms) })}
                      {hits.some((h) => h.kind === 'flowSlow') && <Badge tone="danger">{t('flowMaps.drawer.exceeded')}</Badge>}
                    </li>
                  )}
                  {limits.slowMs !== undefined && (
                    <li className="flex items-center gap-2">
                      {slowLimitText(t, limits)}
                      {hits.some((h) => h.kind === 'flowSlowShare') && <Badge tone="danger">{t('flowMaps.drawer.exceeded')}</Badge>}
                    </li>
                  )}
                  {limits.errorRate !== undefined && (
                    <li className="flex items-center gap-2">
                      {t('flowMaps.drawer.limitErrors', { value: pct(limits.errorRate) })}
                      {hits.some((h) => h.kind === 'flowErrors') && <Badge tone="danger">{t('flowMaps.drawer.exceeded')}</Badge>}
                    </li>
                  )}
                </ul>
              )}
            </div>
          )}
          <Button size="sm" variant="secondary" icon={<Sparkles className="size-3.5" aria-hidden />} onClick={() => onInvestigate(picked)} className="self-start">
            {t('flowMaps.drawer.investigate')}
          </Button>
        </>
      )}
    </aside>
  )
}

/** Every part, slowest first, with its rank, share and numbers; picking a row picks the part in the diagram and the drawer. */
export function PartsTab({ map, reading, ranks, coverage, picked, onPick }: { map: FlowMap; reading?: FlowMapReading; ranks: Ranks; coverage: FlowCoverage; picked: FlowPartRef | null; onPick: (p: FlowPartRef | null) => void }) {
  const { t, formatNumber } = useI18n()
  const rankOf = new Map(ranks.map((r, i) => [`${r.of}:${r.key}`, { rank: i + 1, share: r.share }]))
  const measuredRows = ranks.map((r) => ({ of: r.of, key: r.key, label: r.label, timing: r.timing as Ranks[number]['timing'] | undefined, error: undefined as string | undefined }))
  const rest = flowParts(map)
    .filter((p) => !rankOf.has(`${p.of}:${p.key}`))
    .map((p) => ({ of: p.of, key: p.key, label: p.label, timing: reading?.[p.of][p.key], error: reading?.errors[p.key] }))
  const rows = [...measuredRows, ...rest]
  const noData = new Set(coverage.noData.map((p) => `${p.of}:${p.key}`))
  const unmeasured = new Set(coverage.unmeasured.map((p) => `${p.of}:${p.key}`))
  if (rows.length === 0) return <p className="text-sm text-muted">{t('flowMaps.noMeasures')}</p>
  return (
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
              <tr key={key} className={cn('cursor-pointer border-t border-border hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none', active && 'bg-accent-soft')} {...pressable(() => onPick(active ? null : { of: r.of, key: r.key }), { pressed: active })}>
                <td className="py-1 pr-2 tabular-nums text-muted">{rk ? (rk.rank <= 3 ? <span className="inline-flex size-4 items-center justify-center rounded-full text-[10px] font-bold text-white" style={{ background: '#f97316' }}>{rk.rank}</span> : rk.rank) : ''}</td>
                <td className={cn('py-1 pr-2', unmeasured.has(key) && 'text-muted')}>{r.label}</td>
                {r.error ? (
                  <td colSpan={9} className="py-1 text-right text-danger" title={r.error}>{t('flowMaps.failedShort')}</td>
                ) : unmeasured.has(key) ? (
                  <td colSpan={9} className="py-1 text-right text-subtle">{t('flowMaps.noMeasureShort')}</td>
                ) : !reading ? (
                  <td colSpan={9} className="py-1 text-right text-subtle">{t('flowMaps.tile.noNumbers')}</td>
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
  )
}

/** Columns that only show when the table has room; the drawer always carries them. */
const WIDE = 'hidden lg:table-cell'

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

const ALERT_EXAMPLE = `"alerts": {
  "p95Ms": 3000,
  "errorRate": 0.05,
  "parts": { "orders": { "p95Ms": 1500 } }
}`

/** "> 40 % of calls over 5.0 s" (or "any call over 5.0 s" when the share is unset), for the drawer. */
function slowLimitText(t: ReturnType<typeof useI18n>['t'], limits: FlowLimits): string {
  const over = formatMs(limits.slowMs ?? 0)
  return limits.slowShare ? t('flowMaps.drawer.limitSlowShare', { share: `${Math.round(limits.slowShare * 1000) / 10} %`, over }) : t('flowMaps.drawer.limitSlowAny', { over })
}

/** "40 % > 5.0 s" (or "> 5.0 s"), for the Alerts table. */
function slowLimitShort(limits: FlowLimits): string {
  const over = formatMs(limits.slowMs ?? 0)
  return limits.slowShare ? `${Math.round(limits.slowShare * 1000) / 10} % > ${over}` : `> ${over}`
}

/** Every measured part with its limits (the map's, or its own), its numbers in the window and whether it is above one. */
export function AlertsTab({ map, reading, onPick, onAdjust }: { map: FlowMap; reading?: FlowMapReading; onPick: (p: FlowPartRef) => void; onAdjust?: () => void }) {
  const { t, formatNumber } = useI18n()
  const rows = flowMeasures(map).map((m) => {
    const timing = reading?.[m.of][m.key]
    const limits = flowThresholds(map, m)
    const hits = timing ? breaches(timing, limits) : []
    const live = timing && timing.count > 0 ? timing : undefined
    const slowShare = live && limits.slowMs !== undefined ? slowShareOf(live, limits.slowMs) : undefined
    return { of: m.of, key: m.key, label: flowPartLabel(map, m), timing: live, limits, hits, slowShare }
  })
  const anySlow = rows.some((r) => r.limits.slowMs !== undefined)
  rows.sort((a, b) => b.hits.length - a.hits.length)
  const pct = (r: number) => `${(r * 100).toFixed(1)} %`
  const dash = '–'
  return (
    <div className="flex flex-col gap-3" data-testid="flow-alerts">
      {!hasFlowAlerts(map) && (
        <div className="flex flex-col gap-1.5 text-xs text-muted">
          <p>{t('flowMaps.alerts.noneConfigured')}</p>
          {onAdjust && (
            <Button size="sm" variant="secondary" className="self-start" onClick={onAdjust}>
              {t('flowMaps.alerts.setLimits')}
            </Button>
          )}
          <p>{t('flowMaps.alerts.orInFile')}</p>
          <pre className="overflow-x-auto rounded-md border border-border bg-surface-raised p-2 text-[11px] text-text">{ALERT_EXAMPLE}</pre>
        </div>
      )}
      <p className="text-xs text-subtle">
        {t('flowMaps.alerts.notify')}
        {reading ? ` ${t('flowMaps.alerts.window', { hours: reading.windowHours })}` : ''}
        {hasFlowAlerts(map) && onAdjust && (
          <>
            {' '}
            <button type="button" className={cn(LINK, 'text-accent')} onClick={onAdjust}>
              {t('flowMaps.alerts.editLimits')}
            </button>
          </>
        )}
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
              {anySlow && <th className="whitespace-nowrap py-1 pl-2 text-right font-medium">{t('flowMaps.alerts.slowLimit')}</th>}
              <th className="whitespace-nowrap py-1 pl-2 text-right font-medium">{t('flowMaps.alerts.p95Now')}</th>
              <th className="whitespace-nowrap py-1 pl-2 text-right font-medium">{t('flowMaps.alerts.errorNow')}</th>
              {anySlow && <th className="whitespace-nowrap py-1 pl-2 text-right font-medium">{t('flowMaps.alerts.slowNow')}</th>}
              <th className="whitespace-nowrap py-1 pl-2 text-right font-medium">{t('flowMaps.alerts.status')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const slow = r.hits.some((h) => h.kind === 'flowSlow')
              const failing = r.hits.some((h) => h.kind === 'flowErrors')
              const slowShare = r.hits.some((h) => h.kind === 'flowSlowShare')
              const limited = r.limits.p95Ms !== undefined || r.limits.errorRate !== undefined || r.limits.slowMs !== undefined
              return (
                <tr key={`${r.of}:${r.key}`} className="cursor-pointer border-t border-border hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none" {...pressable(() => onPick({ of: r.of, key: r.key }))}>
                  <td className="py-1 pr-2">{r.label}</td>
                  <td className="whitespace-nowrap py-1 pl-2 text-right tabular-nums">{r.limits.p95Ms !== undefined ? formatMs(r.limits.p95Ms) : dash}</td>
                  <td className="whitespace-nowrap py-1 pl-2 text-right tabular-nums">{r.limits.errorRate !== undefined ? pct(r.limits.errorRate) : dash}</td>
                  {anySlow && <td className="whitespace-nowrap py-1 pl-2 text-right tabular-nums">{r.limits.slowMs !== undefined ? slowLimitShort(r.limits) : dash}</td>}
                  <td className={cn('whitespace-nowrap py-1 pl-2 text-right tabular-nums', slow && 'font-semibold text-danger')}>{r.timing ? formatMs(r.timing.p95Ms) : dash}</td>
                  <td className={cn('whitespace-nowrap py-1 pl-2 text-right tabular-nums', failing && 'font-semibold text-danger')} title={r.timing?.failed !== undefined ? formatNumber(r.timing.failed) : undefined}>{r.timing?.errorRate !== undefined ? pct(r.timing.errorRate) : dash}</td>
                  {anySlow && <td className={cn('whitespace-nowrap py-1 pl-2 text-right tabular-nums', slowShare && 'font-semibold text-danger')}>{r.slowShare !== undefined ? pct(r.slowShare) : dash}</td>}
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
