import { ChevronRight, Power, PowerOff, RefreshCw, RotateCw } from 'lucide-react'
import type { ReactNode } from 'react'
import { visibleMonitorFields, type McpServerStatus, type MonitorField } from '@workhub/core'
import { IconButton, StateDot } from '../../components/atoms'
import { useI18n } from '../../i18n/I18nProvider'
import type { MessageKey } from '../../i18n/translate'
import { formatTokens } from '../../lib/home'
import type { SessionData } from '../../store'
import { AiReviewSection } from './AiReviewPanel'
import { SlackThreadsSection } from './SlackThreadsSection'
import { openSubagent } from '../../lib/subagentView'
import { SubagentSheet } from './SubagentView'

const FIELD_LABEL: Record<MonitorField, MessageKey> = {
  title: 'monitor.title',
  model: 'monitor.model',
  tokens: 'monitor.tokens',
  cost: 'monitor.cost',
  credits: 'monitor.credits',
  context: 'monitor.context',
  toolCalls: 'monitor.toolCalls',
  subagents: 'monitor.subagents',
  activeTime: 'monitor.activeTime',
  planUsage: 'monitor.planUsage',
  mcpServers: 'monitor.mcpServers',
  pullRequests: 'monitor.pullRequests',
  tickets: 'monitor.tickets'
}

/** Fields shown as their own collapsible list under the values. */
const LISTS: MonitorField[] = ['toolCalls', 'subagents', 'mcpServers']

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

function ListSection({ title, count, children, action }: { title: string; count: number; children: ReactNode; action?: ReactNode }) {
  return (
    <details className="group mt-4 border-t border-border pt-3">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-sm text-muted select-none hover:text-text">
        <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" aria-hidden />
        {title}
        <span className="ml-auto text-xs text-subtle tabular-nums">{count}</span>
        {action}
      </summary>
      <ul className="mt-2 flex flex-col gap-1.5">{children}</ul>
    </details>
  )
}

function serverTone(s: McpServerStatus) {
  return s.state === 'running' ? 'success' : s.state === 'needs-auth' || s.state === 'loading' ? 'warning' : s.state === 'failed' ? 'danger' : 'neutral'
}

/** What the agent reports about the session: tokens, cost, tools, subagents, MCP servers, PRs, tickets. */
export function MonitorPanel({ data }: { data: SessionData }) {
  const { t, tn, formatNumber } = useI18n()
  const m = data.monitor
  const v = data.view
  const fields = visibleMonitorFields(v.capabilities, m)
  const n = (x: number | undefined) => (x === undefined ? '–' : formatNumber(x))
  // MCP controls act on the running chat; the console has its own /mcp.
  const controls = v.controls && v.mode !== 'console' && (v.state === 'ready' || v.state === 'busy')
  const value = (f: MonitorField): ReactNode => {
    switch (f) {
      case 'title':
        return m.title
      case 'model':
        return m.model
      case 'tokens':
        return t('monitor.tokensValue', { total: n(m.tokens?.total), input: n(m.tokens?.input), output: n(m.tokens?.output) })
      case 'cost':
        return m.cost ? formatNumber(m.cost.amount, { style: 'currency', currency: m.cost.currency, maximumFractionDigits: 4 }) : ''
      case 'credits':
        return (
          <>
            {t('monitor.creditsValue', { total: (m.credits ?? 0).toFixed(3), last: (m.lastTurnCredits ?? 0).toFixed(3) })}
            {(m.turnCredits?.length ?? 0) > 1 && (
              <span className="mt-0.5 block text-xs text-subtle" data-testid="monitor-turn-credits" title={m.turnCredits!.map((c) => c.toFixed(3)).join(' · ')}>
                {t('monitor.turnCredits', { list: turnCreditsList(m.turnCredits!) })}
              </span>
            )}
          </>
        )
      case 'context':
        return m.context?.percent !== undefined ? `${m.context.percent.toFixed(1)}%` : `${n(m.context?.used)} / ${n(m.context?.size)}`
      case 'activeTime':
        return formatDuration(m.activeTimeMs ?? 0)
      case 'planUsage':
        return m.planUsage?.map((p) => `${p.window}: ${Math.round(p.percent)}%`).join(', ')
      case 'pullRequests':
        return (
          <ul className="flex flex-col gap-0.5">
            {m.pullRequests?.map((url) => (
              <li key={url}>
                <a
                  href={url}
                  className="text-sm break-all text-accent underline underline-offset-2"
                  onClick={(e) => {
                    e.preventDefault()
                    window.hub.openExternal(url)
                  }}
                >
                  {url.replace(/^https:\/\/(www\.)?/, '')}
                </a>
              </li>
            ))}
          </ul>
        )
      case 'tickets':
        return m.ticketKeys?.join(', ')
      default:
        return null
    }
  }
  const servers = m.mcpServers ?? []
  const tools = m.toolCalls ?? []
  const subagents = m.subagents ?? []
  return (
    <aside aria-label={t('monitor.label')} className="w-72 shrink-0 overflow-y-auto border-l border-border bg-sidebar px-4 py-4">
      <h2 className="text-xs font-semibold tracking-wide text-subtle uppercase">{t('monitor.heading')}</h2>
      {fields.length === 0 && <p className="mt-2 text-sm text-subtle">{t('monitor.empty')}</p>}
      <dl className="mt-3 flex flex-col gap-3">
        {fields
          .filter((f) => !LISTS.includes(f))
          .map((f) => (
            <div key={f}>
              <dt className="text-xs text-muted">{t(FIELD_LABEL[f])}</dt>
              <dd className="mt-0.5 text-base break-words tabular-nums">{value(f)}</dd>
            </div>
          ))}
      </dl>
      {fields.includes('toolCalls') && (
        <ListSection title={t('monitor.toolCalls')} count={tools.length}>
          {tools
            .slice(-30)
            .reverse()
            .map((c) => (
              <li key={c.id} className="flex items-start gap-2 text-sm" title={c.detail}>
                <StateDot tone={c.status === 'failed' ? 'danger' : c.status === 'completed' ? 'success' : 'info'} className="mt-1.5" />
                <span className="min-w-0 flex-1 break-words">{c.title}</span>
              </li>
            ))}
        </ListSection>
      )}
      {fields.includes('subagents') && (
        <ListSection title={t('monitor.subagents')} count={subagents.length}>
          {subagents.map((s) => (
            <li key={s.id} className="text-sm">
              <button
                type="button"
                className="-mx-1.5 block w-[calc(100%+0.75rem)] rounded-md px-1.5 py-0.5 text-left hover:bg-surface-hover"
                aria-label={t('subagent.open', { name: s.description ?? s.name ?? s.type ?? s.id })}
                data-testid="subagent-row"
                onClick={() => openSubagent(v.id, s.id)}
              >
                <div className="flex items-center gap-2">
                  <StateDot tone={s.status === 'failed' ? 'danger' : s.status === 'running' ? 'info' : s.status === 'completed' ? 'success' : 'neutral'} pulse={s.status === 'running'} />
                  <span className="min-w-0 flex-1 truncate">{s.description ?? s.name ?? s.type ?? s.id}</span>
                  {s.tokens?.total !== undefined && <span className="text-xs text-subtle tabular-nums">{formatTokens(s.tokens.total)}</span>}
                </div>
                {s.lastStep && <div className="ml-4 truncate text-xs text-subtle">{s.lastStep}</div>}
              </button>
            </li>
          ))}
        </ListSection>
      )}
      {fields.includes('mcpServers') && (
        <ListSection
          title={t('monitor.mcpServers')}
          count={servers.length}
          action={
            controls ? (
              <IconButton
                size="sm"
                className="size-6"
                label={t('monitor.mcpRefresh')}
                icon={<RefreshCw className="size-3" />}
                onClick={(e) => {
                  e.preventDefault()
                  window.hub.sessions.mcp(v.id, 'refresh')
                }}
              />
            ) : undefined
          }
        >
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
        </ListSection>
      )}
      <SubagentSheet sessionId={v.id} />
      <SlackThreadsSection view={v} />
      <AiReviewSection view={v} />
    </aside>
  )
}
