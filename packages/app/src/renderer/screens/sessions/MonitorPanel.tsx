import { Brain, ExternalLink, FilePen, FileSearch, FileText, GitBranch, Globe, MoveRight, Power, PowerOff, RefreshCw, RotateCw, SquareTerminal, Ticket, Trash2, Wrench, type LucideIcon } from 'lucide-react'
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { visibleMonitorFields, type LocalChanges, type McpServerStatus, type PullRequestItem } from '@workhub/core'
import { Badge, IconButton, Spinner, StateDot } from '../../components/atoms'
import { useConfig } from '../../configStore'
import { useI18n } from '../../i18n/I18nProvider'
import { cn } from '../../lib/cn'
import { formatTokens } from '../../lib/home'
import { changesTotal, contextView, dragWidth, requestBars, pullRequestLabel, sessionPullRequests, sessionTicketKeys, sessionTime, subagentTokens } from '../../lib/monitorView'
import { SIZE_RANGES, setPrefs, usePrefs } from '../../lib/prefs'
import { openSubagent } from '../../lib/subagentView'
import { useNow } from '../../lib/usage'
import { useCachedPullRequestLists } from '../../pullRequestsStore'
import type { SessionData } from '../../store'
import { AiReviewSection } from './AiReviewPanel'
import { Legend, MetricBox, MetricRow, MonitorSection, SegmentBar } from './MonitorSection'
import { SessionBudgetSection } from './SessionBudgetSection'
import { SlackThreadsSection } from './SlackThreadsSection'

/** The last turns' credits, newest last: `0.25 · 1.04 · 0.5`, with `…` when older turns are left out. */
export function turnCreditsList(credits: readonly number[], max = 6): string {
  const shown = credits.slice(-max).map((c) => (c >= 10 ? c.toFixed(1) : c.toFixed(2)))
  return `${credits.length > max ? '… ' : ''}${shown.join(' · ')}`
}

/** 75 s → "1 min 15 s"; under a minute, seconds with one decimal. */
export function formatDuration(ms: number): string {
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ${Math.round(s % 60)} s`
  return `${Math.floor(m / 60)} h ${m % 60} min`
}

/** Shorter durations for the boards: "42 s", "3 min", "1 h 5 min". */
function shortDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min`
  return `${Math.floor(m / 60)} h ${m % 60} min`
}

const TOOL_ICON: Record<string, LucideIcon> = {
  read: FileText,
  edit: FilePen,
  delete: Trash2,
  move: MoveRight,
  search: FileSearch,
  execute: SquareTerminal,
  think: Brain,
  fetch: Globe
}

function serverTone(s: McpServerStatus) {
  return s.state === 'running' ? 'success' : s.state === 'needs-auth' || s.state === 'loading' ? 'warning' : s.state === 'failed' ? 'danger' : 'neutral'
}

/** The session folder's uncommitted changes, read every 30 s while the session is on screen. */
function useLocalChanges(id: string, visible: boolean): { changes: LocalChanges | null; loaded: boolean } {
  const [state, setState] = useState<{ changes: LocalChanges | null; loaded: boolean }>({ changes: null, loaded: false })
  useEffect(() => {
    if (!visible) return
    let alive = true
    const read = () =>
      void window.hub.sessions.localChanges(id).then(
        (changes) => alive && setState({ changes, loaded: true }),
        () => alive && setState((s) => ({ ...s, loaded: true }))
      )
    read()
    const timer = setInterval(read, 30_000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [id, visible])
  return state
}

/** The left edge of the panel: drag to resize; the width is kept in the preferences. */
function ResizeHandle({ width, onWidth }: { width: number; onWidth: (w: number, done: boolean) => void }) {
  const { t } = useI18n()
  const [min, max] = SIZE_RANGES.monitorWidth
  const start = useRef<{ x: number; w: number } | null>(null)
  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    start.current = { x: e.clientX, w: width }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const move = (e: ReactPointerEvent<HTMLDivElement>) => start.current && onWidth(dragWidth(start.current.w, start.current.x, e.clientX, min, max), false)
  const up = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!start.current) return
    onWidth(dragWidth(start.current.w, start.current.x, e.clientX, min, max), true)
    start.current = null
  }
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t('monitor.resize')}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') onWidth(Math.min(max, Math.max(min, width + (e.key === 'ArrowLeft' ? 16 : -16))), true)
      }}
      className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize outline-none hover:bg-accent/30 focus-visible:bg-accent/40"
    />
  )
}

function PullRequestCard({ item, profileId }: { item: PullRequestItem; profileId: string | null }) {
  const { t } = useI18n()
  const pr = item.pr
  const stateTone = pr.state === 'merged' ? 'accent' : pr.state === 'closed' ? 'danger' : 'success'
  return (
    <li className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5 text-sm">
        <span className="min-w-0 truncate font-medium">{pullRequestLabel(pr.url)}</span>
        <Badge tone={pr.isDraft ? 'neutral' : stateTone} className="ml-auto shrink-0">
          {pr.isDraft ? t('monitor.prDraft') : t(`monitor.prState.${pr.state}`)}
        </Badge>
      </div>
      <p className="line-clamp-2 text-xs text-muted">{pr.title}</p>
      <div className="flex items-center gap-2 text-xs">
        <span className="text-success tabular-nums">+{pr.additions}</span>
        <span className="text-danger tabular-nums">−{pr.deletions}</span>
        <button type="button" className="ml-auto text-accent hover:underline" onClick={() => void window.hub.codeHost.openWindow(profileId, pr.url)}>
          {t('monitor.viewInApp')}
        </button>
        <IconButton size="sm" className="size-6" label={t('monitor.openOnHost')} icon={<ExternalLink className="size-3" />} onClick={() => void window.hub.codeHost.openExternal(profileId, pr.url)} />
      </div>
    </li>
  )
}

/**
 * The session monitor (Workhub 1's InspectorView): Slack, tickets, pull requests, then the
 * boards (time, tokens, context, requests, activity, subagents, PRs touched), MCP and local work.
 * Sections fold; the panel is resizable. Data an agent does not report is left out, never made up.
 */
export function MonitorPanel({ data, visible }: { data: SessionData; visible: boolean }) {
  const { t, tn, formatNumber } = useI18n()
  const prefs = usePrefs()
  const config = useConfig()
  const m = data.monitor
  const v = data.view
  const profileId = v.profileId ?? config?.config.activeProfileId ?? null
  const fields = visibleMonitorFields(v.capabilities, m)
  const now = useNow(visible ? 5_000 : 600_000)
  const { changes, loaded } = useLocalChanges(v.id, visible)
  const lists = useCachedPullRequestLists(profileId)
  const [dragging, setDragging] = useState<number | null>(null)
  const width = dragging ?? prefs.monitorWidth

  const prs = sessionPullRequests([...(lists?.mine ?? []), ...(lists?.toReview ?? [])], m.pullRequests, changes?.repos)
  const tickets = sessionTicketKeys(prs, m.ticketKeys)
  const time = sessionTime(v.startedAt, now, m.activeTimeMs, m.toolCalls)
  // Before the first state change nothing is known yet: say so rather than show 0.
  const activeKnown = m.activeTimeMs !== undefined
  const ctx = fields.includes('context') ? contextView(m.context) : null
  const requests = requestBars(m.turnRequests)
  const ofSubagents = subagentTokens(m.subagents)
  const servers = m.mcpServers ?? []
  const tools = m.toolCalls ?? []
  const subagents = m.subagents ?? []
  // MCP controls act on the running chat; the console has its own /mcp.
  const controls = v.controls && v.mode !== 'console' && (v.state === 'ready' || v.state === 'busy')
  const n = (x: number | undefined) => (x === undefined ? '–' : formatTokens(x))
  const showTokens = fields.includes('tokens') || fields.includes('cost') || fields.includes('credits')
  const total = changes ? changesTotal(changes) : null

  return (
    <aside aria-label={t('monitor.label')} className="relative shrink-0 border-l border-border bg-sidebar" style={{ width }} data-monitor-of={v.id}>
      <ResizeHandle
        width={width}
        onWidth={(w, done) => {
          if (done) {
            setDragging(null)
            setPrefs({ monitorWidth: w })
          } else setDragging(w)
        }}
      />
      <div className="flex h-full flex-col gap-4 overflow-y-auto px-3.5 py-3.5">
        <div>
          <h2 className="text-md font-semibold">{t('monitor.heading')}</h2>
          {m.title && <p className="mt-0.5 line-clamp-2 text-xs text-muted" title={m.title}>{m.title}</p>}
        </div>

        <SlackThreadsSection view={v} />

        {tickets.length > 0 && (
          <MonitorSection id="tickets" title={tn('monitor.ticketsCount', tickets.length)}>
            <ul className="flex flex-wrap gap-1.5">
              {tickets.map((key) => (
                <li key={key}>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 rounded-md bg-sidebar px-1.5 py-0.5 font-mono text-xs text-accent hover:bg-surface-hover"
                    onClick={() => profileId && void window.hub.tickets.openWindow(profileId, key)}
                    disabled={!profileId}
                  >
                    <Ticket className="size-3" aria-hidden />
                    {key}
                  </button>
                </li>
              ))}
            </ul>
          </MonitorSection>
        )}

        {prs.length > 0 && (
          <MonitorSection id="pullRequests" title={tn('monitor.prsCount', prs.length)}>
            <ul className="flex flex-col gap-3 divide-border [&>li+li]:border-t [&>li+li]:pt-3">
              {prs.map((item) => (
                <PullRequestCard key={item.pr.url} item={item} profileId={profileId} />
              ))}
            </ul>
          </MonitorSection>
        )}

        <MonitorSection id="sessionTime" title={t('monitor.sessionTime')}>
          <div className="flex flex-col gap-2.5">
            <div className="flex gap-2">
              <MetricBox label={t('monitor.alive')} value={shortDuration(time.aliveMs)} note={t('monitor.aliveNote')} />
              <MetricBox
                label={t('monitor.active')}
                value={activeKnown ? shortDuration(time.activeMs) : '–'}
                note={activeKnown ? t('monitor.activeNote', { percent: time.activePercent }) : t('monitor.notReported')}
              />
            </div>
            {activeKnown && (
              <>
                <SegmentBar
                  segments={[
                    { value: time.thinkingMs, className: 'bg-info' },
                    { value: time.toolMs, className: 'bg-warning' },
                    { value: time.idleMs, className: 'bg-border-strong' }
                  ]}
                />
                <div className="flex flex-wrap gap-x-3 gap-y-1">
                  <Legend className="bg-info" text={t('monitor.thinking', { time: shortDuration(time.thinkingMs) })} />
                  <Legend className="bg-warning" text={t('monitor.toolsTime', { time: shortDuration(time.toolMs) })} />
                  <Legend className="bg-border-strong" text={t('monitor.idle', { time: shortDuration(time.idleMs) })} />
                </div>
              </>
            )}
          </div>
        </MonitorSection>

        {showTokens && (
          <MonitorSection id="tokens" title={t('monitor.tokens')}>
            <div className="flex flex-col gap-2.5">
              <div className="flex gap-2">
                <MetricBox label={t('monitor.thisChat')} value={n(m.tokens?.total)} note={t('monitor.allTurns')} />
                {fields.includes('cost') && m.cost && (
                  <MetricBox
                    label={t('monitor.cost')}
                    value={formatNumber(m.cost.amount, { style: 'currency', currency: m.cost.currency, maximumFractionDigits: 2 })}
                    note={t('monitor.costNote')}
                  />
                )}
                {fields.includes('credits') && (
                  <MetricBox label={t('monitor.credits')} value={(m.credits ?? 0).toFixed(2)} note={t('monitor.lastTurn', { value: (m.lastTurnCredits ?? 0).toFixed(2) })} />
                )}
              </div>
              {(m.turnCredits?.length ?? 0) > 1 && (
                <p className="text-xs text-subtle" data-testid="monitor-turn-credits" title={m.turnCredits!.map((c) => c.toFixed(3)).join(' · ')}>
                  {t('monitor.turnCredits', { list: turnCreditsList(m.turnCredits!) })}
                </p>
              )}
              {m.tokens && (
                <div className="flex flex-col gap-1">
                  <MetricRow label={t('monitor.input')} value={n(m.tokens.input)} />
                  {m.tokens.cacheWrite !== undefined && <MetricRow label={t('monitor.cacheWrite')} value={n(m.tokens.cacheWrite)} />}
                  <MetricRow label={t('monitor.output')} value={n(m.tokens.output)} />
                  {ofSubagents !== undefined && <MetricRow label={t('monitor.ofSubagents')} value={n(ofSubagents)} />}
                  {m.tokens.cacheRead !== undefined && <MetricRow label={t('monitor.cacheRead')} value={n(m.tokens.cacheRead)} />}
                </div>
              )}
              {fields.includes('planUsage') && (
                <div className="flex flex-col gap-1">
                  {m.planUsage!.map((p) => (
                    <MetricRow key={p.window} label={`${t('monitor.planUsage')} · ${p.window}`} value={`${Math.round(p.percent)}%`} />
                  ))}
                </div>
              )}
              {fields.includes('model') && <p className="truncate text-xs text-subtle" title={m.model}>{m.model}</p>}
            </div>
          </MonitorSection>
        )}

        {ctx && (
          <MonitorSection id="context" title={t('monitor.context')}>
            <div className="flex flex-col gap-1.5">
              <div className="flex items-baseline justify-between text-sm tabular-nums">
                <span>{ctx.used !== undefined && ctx.size !== undefined ? `${formatTokens(ctx.used)} / ${formatTokens(ctx.size)}` : '–'}</span>
                <span className={cn(ctx.high ? 'font-medium text-warning' : 'text-muted')} data-testid="monitor-context-percent">
                  {Math.round(ctx.fraction * 100)}%
                </span>
              </div>
              <SegmentBar segments={[{ value: ctx.fraction, className: ctx.high ? 'bg-warning' : 'bg-accent' }, { value: 1 - ctx.fraction, className: 'bg-transparent' }]} />
            </div>
          </MonitorSection>
        )}

        <SessionBudgetSection view={v} />

        {requests && (
          <MonitorSection id="requests" title={t('monitor.requests')}>
            <div className="flex flex-col gap-1.5">
              <div className="flex h-11 items-end gap-[3px]" role="img" aria-label={t('monitor.requests')}>
                {requests.bars.map((bar, i) => (
                  <div key={i} className="min-w-[3px] flex-1 rounded-sm bg-info" style={{ height: `${Math.round(bar.fraction * 100)}%` }} title={t('monitor.requestTip', { value: formatTokens(bar.value) })} />
                ))}
              </div>
              <p className="text-xs text-muted">{t('monitor.requestsSummary', { count: requests.bars.length, max: formatTokens(requests.max) })}</p>
            </div>
          </MonitorSection>
        )}

        {v.capabilities.appMode && (
          <MonitorSection id="activity" title={t('monitor.activity')} count={tools.length || undefined}>
            {tools.length === 0 ? (
              <p className="text-sm text-subtle">{t('monitor.noToolCalls')}</p>
            ) : (
              <ul className="-mr-1.5 flex max-h-60 flex-col gap-2 overflow-y-auto pr-1.5">
                {tools
                  .slice(-40)
                  .reverse()
                  .map((c) => {
                    const Icon = TOOL_ICON[c.kind ?? ''] ?? Wrench
                    const failed = c.status === 'failed'
                    const done = c.status === 'completed' || failed
                    return (
                      <li key={c.id} className="flex items-start gap-2 text-sm">
                        <Icon className={cn('mt-0.5 size-3.5 shrink-0', failed ? 'text-danger' : done ? 'text-subtle' : 'text-info')} aria-hidden />
                        <div className="min-w-0 flex-1">
                          <div className="line-clamp-2 break-words">{c.title}</div>
                          {c.detail && (
                            <div className="truncate font-mono text-2xs text-subtle" title={c.detail}>
                              {c.detail}
                            </div>
                          )}
                        </div>
                        {done ? (
                          c.startedAt !== undefined && c.endedAt !== undefined && <span className={cn('shrink-0 text-2xs tabular-nums', failed ? 'text-danger' : 'text-subtle')}>{formatDuration(c.endedAt - c.startedAt)}</span>
                        ) : (
                          <Spinner className="mt-0.5 size-3 shrink-0" />
                        )}
                      </li>
                    )
                  })}
              </ul>
            )}
          </MonitorSection>
        )}

        {fields.includes('subagents') && (
          <MonitorSection id="subagents" title={t('monitor.subagents')} count={subagents.length}>
            <ul className="-mx-1.5 flex flex-col gap-0.5">
              {subagents.map((s) => (
                <li key={s.id} className="text-sm">
                  <button
                    type="button"
                    className="block w-full rounded-md px-1.5 py-1 text-left hover:bg-surface-hover"
                    aria-label={t('subagent.open', { name: s.description ?? s.name ?? s.type ?? s.id })}
                    data-testid="subagent-row"
                    onClick={() => openSubagent(v.id, s.id)}
                  >
                    <div className="flex items-center gap-2">
                      <StateDot tone={s.status === 'failed' ? 'danger' : s.status === 'running' ? 'info' : s.status === 'completed' ? 'success' : 'neutral'} pulse={s.status === 'running'} />
                      <span className="min-w-0 flex-1 truncate">{s.description ?? s.name ?? s.type ?? s.id}</span>
                      {s.tokens?.total !== undefined && <span className="text-xs text-subtle tabular-nums">{formatTokens(s.tokens.total)}</span>}
                    </div>
                    {(s.model || s.lastStep) && <div className="ml-4 truncate text-xs text-subtle">{[s.model, s.lastStep].filter(Boolean).join(' · ')}</div>}
                  </button>
                </li>
              ))}
            </ul>
          </MonitorSection>
        )}

        {fields.includes('pullRequests') && (
          <MonitorSection id="touchedPrs" title={t('monitor.touchedPrs')} count={m.pullRequests!.length}>
            <ul className="-mx-1.5 flex flex-col gap-0.5">
              {m.pullRequests!.map((url) => (
                <li key={url}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm hover:bg-surface-hover"
                    title={url}
                    onClick={() => void window.hub.codeHost.openWindow(profileId, url)}
                  >
                    <GitBranch className="size-3.5 shrink-0 text-subtle" aria-hidden />
                    <span className="min-w-0 flex-1 truncate font-medium">{pullRequestLabel(url)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </MonitorSection>
        )}

        {fields.includes('mcpServers') && (
          <MonitorSection
            id="mcp"
            title={t('monitor.mcpServers')}
            count={servers.length}
            action={controls ? <IconButton size="sm" className="size-6" label={t('monitor.mcpRefresh')} icon={<RefreshCw className="size-3" />} onClick={() => window.hub.sessions.mcp(v.id, 'refresh')} /> : undefined}
          >
            <ul className="flex flex-col gap-1">
              {servers.map((s) => (
                <li key={s.name} className="flex items-center gap-2 text-sm" title={s.error ?? s.source}>
                  <StateDot tone={serverTone(s)} />
                  <span className="min-w-0 flex-1 truncate">{s.name}</span>
                  <span className="text-xs text-subtle">{s.state === 'running' && s.toolCount ? tn('monitor.tools', s.toolCount) : t(`mcp.${s.state}`)}</span>
                  {controls && (s.state === 'failed' || s.state === 'needs-auth') && (
                    <IconButton size="sm" className="size-6" label={t('monitor.mcpReconnect', { name: s.name })} icon={<RotateCw className="size-3" />} onClick={() => window.hub.sessions.mcp(v.id, 'reconnect', s.name)} />
                  )}
                  {controls && (
                    <IconButton
                      size="sm"
                      className="size-6"
                      label={t(s.state === 'disabled' ? 'monitor.mcpEnable' : 'monitor.mcpDisable', { name: s.name })}
                      icon={s.state === 'disabled' ? <Power className="size-3" /> : <PowerOff className="size-3" />}
                      onClick={() => window.hub.sessions.mcp(v.id, s.state === 'disabled' ? 'enable' : 'disable', s.name)}
                    />
                  )}
                </li>
              ))}
            </ul>
          </MonitorSection>
        )}

        {(!loaded || changes) && (
          <MonitorSection id="localChanges" title={t('monitor.localChanges')}>
            {!loaded ? (
              <div className="flex items-center gap-2 text-sm text-muted">
                <Spinner className="size-3.5" />
                {t('monitor.readingRepos')}
              </div>
            ) : (
              changes &&
              total && (
                <div className="flex flex-col gap-2" data-testid="monitor-local-changes">
                  <div className="flex items-baseline gap-2 text-sm">
                    <span className="min-w-0 flex-1 truncate">
                      {total.files === 0
                        ? t(changes.nested ? 'monitor.noChangesNested' : 'monitor.noChanges')
                        : changes.nested
                          ? `${tn('monitor.repos', total.repos)} · ${tn('monitor.files', total.files)}`
                          : tn('monitor.files', total.files)}
                    </span>
                    {total.files > 0 && (
                      <span className="shrink-0 tabular-nums">
                        <span className="text-success">+{total.additions}</span> <span className="text-danger">−{total.deletions}</span>
                      </span>
                    )}
                  </div>
                  {(changes.nested ? changes.repos : changes.repos.filter((r) => r.branch)).map((r) => (
                    <div key={r.root} className="flex items-center gap-1.5 text-xs text-muted" title={r.root}>
                      <GitBranch className="size-3 shrink-0" aria-hidden />
                      <span className="min-w-0 flex-1 truncate">
                        {changes.nested && <span className="text-text">{r.name} </span>}
                        {r.branch ?? '–'}
                      </span>
                      {changes.nested && (
                        <span className="shrink-0 tabular-nums">
                          {r.files} · <span className="text-success">+{r.additions}</span> <span className="text-danger">−{r.deletions}</span>
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )
            )}
          </MonitorSection>
        )}

        <AiReviewSection view={v} />
      </div>
    </aside>
  )
}
