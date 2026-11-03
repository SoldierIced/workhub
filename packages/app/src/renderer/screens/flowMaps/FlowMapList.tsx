import { Search } from 'lucide-react'
import type { FlowMapState, FlowMapSummary } from '@shared/health-api'
import { Input, StateDot } from '../../components/atoms'
import type { Tone } from '../../components/atoms/Badge'
import { useI18n } from '../../i18n/I18nProvider'
import { cn } from '../../lib/cn'

export interface FlowMapGroup {
  /** The map's `group`, or null for the maps without one (listed last). */
  name: string | null
  maps: FlowMapSummary[]
}

const fold = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()

/**
 * The maps under their headings, headings and maps by name; `query` keeps the maps whose name,
 * group, description or id contains every word of it (accents and case ignored).
 */
export function groupFlowMaps(maps: readonly FlowMapSummary[], query = ''): FlowMapGroup[] {
  const words = fold(query).split(/\s+/).filter(Boolean)
  const matches = (m: FlowMapSummary) => {
    const text = fold([m.name, m.group ?? '', m.description ?? '', m.id].join(' '))
    return words.every((w) => text.includes(w))
  }
  const byGroup = new Map<string | null, FlowMapSummary[]>()
  for (const m of maps) {
    if (!matches(m)) continue
    const key = m.group?.trim() || null
    byGroup.set(key, [...(byGroup.get(key) ?? []), m])
  }
  const named = [...byGroup.keys()].filter((k): k is string => k !== null).sort((a, b) => a.localeCompare(b))
  const order: (string | null)[] = byGroup.has(null) ? [...named, null] : named
  return order.map((name) => ({ name, maps: [...byGroup.get(name)!].sort((a, b) => a.name.localeCompare(b.name)) }))
}

const STATE_TONE: Record<FlowMapState, Tone> = { ok: 'success', alert: 'danger', unknown: 'neutral' }

export interface FlowMapListProps {
  maps: readonly FlowMapSummary[]
  states: Record<string, FlowMapState>
  opened: string | null
  query: string
  onQuery: (query: string) => void
  onOpen: (id: string) => void
}

/** The side list of the Flow maps screen: a search box and the maps under their headings, each with its state. */
export function FlowMapList({ maps, states, opened, query, onQuery, onOpen }: FlowMapListProps) {
  const { t } = useI18n()
  const groups = groupFlowMaps(maps, query)
  return (
    <nav aria-label={t('flowMaps.maps')} className="flex w-60 shrink-0 flex-col gap-2" data-testid="flow-map-list">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted" aria-hidden />
        <Input value={query} onChange={(e) => onQuery(e.target.value)} placeholder={t('flowMaps.search')} aria-label={t('flowMaps.search')} className="pl-7" />
      </div>
      {groups.length === 0 && <p className="px-1 text-xs text-muted">{t('flowMaps.noMatch')}</p>}
      <div className="flex max-h-[calc(100vh-14rem)] flex-col gap-3 overflow-y-auto pr-1">
        {groups.map((g) => (
          <section key={g.name ?? ''} className="flex flex-col gap-0.5">
            <h3 className="px-2 text-[11px] font-medium uppercase tracking-wide text-muted">{g.name ?? t('flowMaps.ungrouped')}</h3>
            <ul className="flex flex-col gap-0.5">
              {g.maps.map((m) => {
                const state = states[m.id] ?? 'unknown'
                return (
                  <li key={m.id}>
                    <button
                      type="button"
                      disabled={Boolean(m.error)}
                      aria-current={opened === m.id ? 'true' : undefined}
                      title={m.error ? t('flowMaps.invalid', { error: m.error }) : m.description ?? m.file}
                      onClick={() => onOpen(m.id)}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
                        m.error ? 'text-danger' : opened === m.id ? 'bg-accent-soft font-medium' : 'hover:bg-surface-hover'
                      )}
                    >
                      <StateDot tone={m.error ? 'danger' : STATE_TONE[state]} />
                      <span className="min-w-0 flex-1 truncate">{m.name}</span>
                      <span className="sr-only">{m.error ? t('flowMaps.invalidShort') : t(`flowMaps.state.${state}`)}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </section>
        ))}
      </div>
    </nav>
  )
}
