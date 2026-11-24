import { ArrowUpDown, Check, Minus, Search } from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import { useMemo, useState } from 'react'
import type { MergedPullRequest } from '@workhub/core'
import { FILTER_ITEM, FILTER_MENU } from '../../components/molecules/FilterChip'
import { ActiveFilterChips, FilterOption, FiltersPopover, type ActiveFilter } from '../../components/molecules/FiltersPopover'
import { seriesColor } from '../../components/molecules/StackedBarChart'
import { useI18n } from '../../i18n/I18nProvider'
import { cn } from '../../lib/cn'
import {
  clearMergedNarrowing,
  groupOf,
  GROUP_SLOT,
  intoIsOn,
  intoOptions,
  isMergedNarrowed,
  MERGED_ORDERS,
  mergedNarrowingCount,
  mergedOptions,
  RELEASE_ALL,
  releaseSelection,
  toggleInto,
  toggleMergedValue,
  type BranchGroup,
  type MergedNarrowing
} from '../../lib/mergedStats'

interface BarProps {
  /** The period's merged PRs after the search, before the filters. */
  items: readonly MergedPullRequest[]
  /** How many the filters keep. */
  shown: number
  value: MergedNarrowing
  onChange: (n: MergedNarrowing) => void
}

/** An Into choice: a swatch of the branch's group and its name; `mixed` when `release/*` has only some branches on. */
function IntoChoice({ label, state, group, child, count, onToggle, title }: { label: string; state: 'on' | 'off' | 'mixed'; group: BranchGroup; child: boolean; count: number; onToggle: () => void; title?: string }) {
  const { tn } = useI18n()
  return (
    <button
      type="button"
      aria-pressed={state === 'mixed' ? 'mixed' : state === 'on'}
      onClick={onToggle}
      title={title ?? tn('pr.count', count)}
      className={cn(
        'inline-flex h-6 max-w-full items-center gap-1.5 rounded-full border px-2.5 text-xs whitespace-nowrap transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
        child && 'ml-3',
        state !== 'off' ? 'border-accent bg-accent-soft text-text' : 'border-border-strong text-text hover:bg-surface-hover'
      )}
    >
      {state === 'on' && <Check className="size-3 shrink-0" aria-hidden />}
      {state === 'mixed' && <Minus className="size-3 shrink-0" aria-hidden />}
      <span className="size-2 shrink-0 rounded-sm" style={{ background: seriesColor(GROUP_SLOT[group]) }} aria-hidden />
      <span className="truncate font-mono">{label}</span>
      <span className="text-subtle tabular-nums">{count}</span>
    </button>
  )
}

/** The panel: Author, Into (every target branch, `release/*` for all releases) and Repo, with counts under the other filters. */
export function MergedFilterPanel({ items, shown, value, onChange }: BarProps) {
  const { t, tn } = useI18n()
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const match = (s: string) => needle === '' || s.toLowerCase().includes(needle)
  const into = useMemo(() => intoOptions(items, value), [items, value])
  const releaseBranches = useMemo(() => [...new Set(items.map((i) => i.base).filter((b) => groupOf(b) === 'release'))], [items])
  const release = releaseSelection(value.into, releaseBranches)
  const repos = useMemo(() => mergedOptions(items, value, 'repos'), [items, value])
  const authors = useMemo(() => mergedOptions(items, value, 'authors'), [items, value])
  const intoShown = into.filter((o) => match(o.value) || match(t('pr.narrow.base')))
  const repoShown = repos.filter((o) => match(o.value) || match(t('pr.narrow.repo')))
  const authorShown = authors.filter((o) => match(o.value) || match(t('pr.narrow.author')))
  const none = intoShown.length + repoShown.length + authorShown.length === 0

  return (
    <div className="flex flex-col" data-testid="merged-filter-panel">
      <label className="mb-2 flex h-8 items-center gap-2 rounded-md border border-border px-2.5 text-subtle focus-within:border-accent">
        <Search className="size-3.5 shrink-0" aria-hidden />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('pr.narrow.find')}
          aria-label={t('pr.narrow.find')}
          className="min-w-0 flex-1 bg-transparent text-base text-text placeholder:text-subtle focus:outline-none"
        />
      </label>
      {none && <p className="border-t border-border py-3 text-sm text-muted">{t('pr.narrow.noMatch', { query: query.trim() })}</p>}
      {/* Author first: the filter used most. */}
      {authorShown.length > 0 && (
        <div role="group" aria-label={t('pr.narrow.author')} className="border-t border-border py-2.5">
          <div className="mb-1.5 text-xs text-subtle">{t('pr.narrow.author')}</div>
          <div className="flex flex-wrap gap-1.5">
            {authorShown.map((o) => (
              <FilterOption key={o.value} label={o.value} on={value.authors.includes(o.value)} onToggle={() => onChange(toggleMergedValue(value, 'authors', o.value))} title={tn('pr.count', o.count)} />
            ))}
          </div>
        </div>
      )}
      {intoShown.length > 0 && (
        <div role="group" aria-label={t('pr.narrow.base')} className="border-t border-border py-2.5">
          <div className="mb-1.5 text-xs text-subtle">{t('pr.narrow.base')}</div>
          <div className="flex flex-wrap gap-1.5">
            {intoShown.map((o) =>
              o.value === RELEASE_ALL ? (
                <IntoChoice key={o.value} label={RELEASE_ALL} state={release === 'all' ? 'on' : release === 'some' ? 'mixed' : 'off'} group={o.group} child={false} count={o.count} title={t('pr.merged.narrow.releaseHint')} onToggle={() => onChange(toggleInto(value, o.value, releaseBranches))} />
              ) : (
                <IntoChoice key={o.value} label={o.value} state={intoIsOn(value.into, o.value) ? 'on' : 'off'} group={o.group} child={o.child} count={o.count} onToggle={() => onChange(toggleInto(value, o.value, releaseBranches))} />
              )
            )}
          </div>
        </div>
      )}
      {repoShown.length > 0 && (
        <div role="group" aria-label={t('pr.narrow.repo')} className="border-t border-border py-2.5">
          <div className="mb-1.5 text-xs text-subtle">{t('pr.narrow.repo')}</div>
          <div className="flex flex-wrap gap-1.5">
            {repoShown.map((o) => (
              <FilterOption key={o.value} label={o.value} on={value.repos.includes(o.value)} onToggle={() => onChange(toggleMergedValue(value, 'repos', o.value))} title={tn('pr.count', o.count)} />
            ))}
          </div>
        </div>
      )}
      <div className="mt-0.5 flex items-center gap-2 border-t border-border pt-2.5">
        <span className="text-xs text-subtle tabular-nums" data-testid="merged-filter-shown">
          {t('pr.narrow.shown', { shown, total: items.length })}
        </span>
        <button
          type="button"
          disabled={!isMergedNarrowed(value)}
          onClick={() => onChange(clearMergedNarrowing(value))}
          className="ml-auto inline-flex h-6 items-center rounded-sm px-2 text-sm text-muted hover:bg-surface-hover hover:text-text disabled:pointer-events-none disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          {t('pr.narrow.clear')}
        </button>
      </div>
    </div>
  )
}

function OrderMenu({ value, onChange }: Pick<BarProps, 'value' | 'onChange'>) {
  const { t } = useI18n()
  const label = t(`pr.merged.narrow.order.${value.order}`)
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        title={t('pr.narrow.order')}
        aria-label={`${t('pr.narrow.order')}: ${label}`}
        className="inline-flex h-6 items-center gap-1 rounded-sm px-1.5 text-xs text-muted hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        <ArrowUpDown className="size-3" aria-hidden />
        {label}
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" sideOffset={4} className={FILTER_MENU}>
          <DropdownMenu.RadioGroup value={value.order} onValueChange={(v) => onChange({ ...value, order: v as MergedNarrowing['order'] })}>
            {MERGED_ORDERS.map((o) => (
              <DropdownMenu.RadioItem key={o} value={o} className={FILTER_ITEM}>
                <span className="flex w-4 justify-center">
                  <DropdownMenu.ItemIndicator>
                    <Check className="size-3.5" aria-hidden />
                  </DropdownMenu.ItemIndicator>
                </span>
                {t(`pr.merged.narrow.order.${o}`)}
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

/** The Merged view's filters: the Filters button and its panel, the order, and the filters in use as chips. */
export function MergedNarrowingBar({ items, shown, value, onChange }: BarProps) {
  const { t } = useI18n()
  const chips: ActiveFilter[] = [
    ...value.into.map((v) => ({ key: `into:${v}`, label: t('pr.narrow.chip', { title: t('pr.narrow.base'), value: v }), onRemove: () => onChange(toggleInto(value, v, [...new Set(items.map((i) => i.base).filter((b) => groupOf(b) === 'release'))])) })),
    ...value.repos.map((v) => ({ key: `repos:${v}`, label: t('pr.narrow.chip', { title: t('pr.narrow.repo'), value: v }), onRemove: () => onChange(toggleMergedValue(value, 'repos', v)) })),
    ...value.authors.map((v) => ({ key: `authors:${v}`, label: t('pr.narrow.chip', { title: t('pr.narrow.author'), value: v }), onRemove: () => onChange(toggleMergedValue(value, 'authors', v)) }))
  ]
  return (
    <div role="group" aria-label={t('pr.narrow.bar')} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <FiltersPopover label={t('pr.narrow.filters')} count={mergedNarrowingCount(value)} width={372} data-testid="merged-filters">
          <MergedFilterPanel items={items} shown={shown} value={value} onChange={onChange} />
        </FiltersPopover>
        <OrderMenu value={value} onChange={onChange} />
      </div>
      <ActiveFilterChips filters={chips} clearLabel={t('pr.narrow.clear')} removeLabel={(label) => t('pr.narrow.remove', { label })} onClear={() => onChange(clearMergedNarrowing(value))} data-testid="merged-active-filters" />
    </div>
  )
}
