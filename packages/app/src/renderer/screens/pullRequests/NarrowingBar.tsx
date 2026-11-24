import { ArrowUpDown, Check, Search } from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import { useState } from 'react'
import type { PullRequestItem, PullRequestStatus } from '@workhub/core'
import { FILTER_ITEM, FILTER_MENU } from '../../components/molecules/FilterChip'
import { ActiveFilterChips, FilterOption, FiltersPopover, type ActiveFilter } from '../../components/molecules/FiltersPopover'
import { useI18n } from '../../i18n/I18nProvider'
import {
  clearNarrowing,
  isNarrowed,
  narrowingCount,
  panelOptions,
  PR_ORDERS,
  ticketCounts,
  toggleTicket,
  toggleValue,
  type NarrowField,
  type PrNarrowing
} from '../../lib/prNarrowing'
import { STATUS_META } from '../../lib/pullRequests'
import type { MessageKey } from '../../i18n/translate'

// Author first: the filter used most (the same order as the Merged view's panel).
const FIELDS: { field: NarrowField; title: MessageKey }[] = [
  { field: 'authors', title: 'pr.narrow.author' },
  { field: 'statuses', title: 'pr.narrow.status' },
  { field: 'bases', title: 'pr.narrow.base' },
  { field: 'repos', title: 'pr.narrow.repo' }
]
const TICKET_CHOICES = ['with', 'without'] as const

interface NarrowingProps {
  /** The PRs of the tab on screen, before the filters. */
  items: PullRequestItem[]
  /** How many the filters (and the search) keep. */
  shown: number
  value: PrNarrowing
  onChange: (n: PrNarrowing) => void
}

/** A status shows by its badge's name; the other fields by their own value. */
function useOptionLabel() {
  const { t } = useI18n()
  return (field: NarrowField, v: string) => (field === 'statuses' ? t(STATUS_META[v as PullRequestStatus]?.label ?? 'pr.narrow.status') : v)
}

/**
 * The list's filters: one "Filters · N" button whose panel holds status, target branch,
 * repository, author and ticket, the order picker beside it, and the filters in use as chips
 * under them.
 */
export function NarrowingBar({ items, shown, value, onChange }: NarrowingProps) {
  const { t } = useI18n()
  return (
    <div role="group" aria-label={t('pr.narrow.bar')} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <FiltersPopover label={t('pr.narrow.filters')} count={narrowingCount(value)} width={372} data-testid="pr-filters">
          <PrFilterPanel items={items} shown={shown} value={value} onChange={onChange} />
        </FiltersPopover>
        <OrderMenu value={value} onChange={onChange} />
      </div>
      <PrActiveFilters value={value} onChange={onChange} />
    </div>
  )
}

/** The list's order, beside the Filters button (not a filter, so not in the panel). */
function OrderMenu({ value, onChange }: Pick<NarrowingProps, 'value' | 'onChange'>) {
  const { t } = useI18n()
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        title={t('pr.narrow.order')}
        aria-label={`${t('pr.narrow.order')}: ${t(`pr.narrow.order.${value.order}`)}`}
        className="inline-flex h-6 items-center gap-1 rounded-sm px-1.5 text-xs text-muted hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        <ArrowUpDown className="size-3" aria-hidden />
        {t(`pr.narrow.order.${value.order}`)}
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" sideOffset={4} className={FILTER_MENU}>
          <DropdownMenu.RadioGroup value={value.order} onValueChange={(v) => onChange({ ...value, order: v as PrNarrowing['order'] })}>
            {PR_ORDERS.map((o) => (
              <DropdownMenu.RadioItem key={o} value={o} className={FILTER_ITEM}>
                <span className="flex w-4 justify-center">
                  <DropdownMenu.ItemIndicator>
                    <Check className="size-3.5" aria-hidden />
                  </DropdownMenu.ItemIndicator>
                </span>
                {t(`pr.narrow.order.${o}`)}
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

/** Every value in use as a chip ("Repo: storefront ×") and Clear, which keeps the order. */
export function PrActiveFilters({ value, onChange }: Pick<NarrowingProps, 'value' | 'onChange'>) {
  const { t } = useI18n()
  const optionLabel = useOptionLabel()
  const chips: ActiveFilter[] = FIELDS.flatMap(({ field, title }) =>
    value[field].map((v) => ({ key: `${field}:${v}`, label: t('pr.narrow.chip', { title: t(title), value: optionLabel(field, v) }), onRemove: () => onChange(toggleValue(value, field, v)) }))
  )
  if (value.ticket !== 'any') {
    chips.push({ key: 'ticket', label: t('pr.narrow.chip', { title: t('pr.narrow.ticket'), value: t(`pr.narrow.ticket.${value.ticket}`) }), onRemove: () => onChange({ ...value, ticket: 'any' }) })
  }
  return <ActiveFilterChips filters={chips} clearLabel={t('pr.narrow.clear')} removeLabel={(label) => t('pr.narrow.remove', { label })} onClear={() => onChange(clearNarrowing(value))} data-testid="pr-active-filters" />
}

/**
 * The panel's content: a box that narrows the options shown, one group per filter whose options
 * toggle (status, branch, repository and author take several; ticket one), and how many PRs the
 * filters keep, with Clear.
 */
export function PrFilterPanel({ items, shown, value, onChange, initialQuery = '' }: NarrowingProps & { initialQuery?: string }) {
  const { t, tn } = useI18n()
  const optionLabel = useOptionLabel()
  const [query, setQuery] = useState(initialQuery)
  const needle = query.trim().toLowerCase()
  // A group whose name matches keeps all its options; otherwise only the options that match.
  const keep = (title: string, label: string) => needle === '' || title.toLowerCase().includes(needle) || label.toLowerCase().includes(needle)
  const tickets = ticketCounts(items)
  const groups = [
    ...FIELDS.map(({ field, title }) => ({
      key: field,
      title: t(title),
      options: panelOptions(items, value, field).map((o) => ({
        key: o.value,
        label: optionLabel(field, o.value),
        count: o.count,
        on: value[field].includes(o.value),
        toggle: () => onChange(toggleValue(value, field, o.value))
      }))
    })),
    {
      key: 'ticket',
      title: t('pr.narrow.ticket'),
      options: TICKET_CHOICES.map((c) => ({ key: c, label: t(`pr.narrow.ticket.${c}`), count: tickets[c], on: value.ticket === c, toggle: () => onChange(toggleTicket(value, c)) }))
    }
  ]
    .map((g) => ({ ...g, options: g.options.filter((o) => keep(g.title, o.label)) }))
    .filter((g) => g.options.length > 0)

  return (
    <div className="flex flex-col" data-testid="pr-filter-panel">
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
      {groups.length === 0 && <p className="border-t border-border py-3 text-sm text-muted">{t('pr.narrow.noMatch', { query: query.trim() })}</p>}
      {groups.map((g) => (
        <div key={g.key} role="group" aria-label={g.title} className="border-t border-border py-2.5">
          <div className="mb-1.5 text-xs text-subtle">{g.title}</div>
          <div className="flex flex-wrap gap-1.5">
            {g.options.map((o) => (
              <FilterOption key={o.key} label={o.label} on={o.on} onToggle={o.toggle} title={tn('pr.count', o.count)} />
            ))}
          </div>
        </div>
      ))}
      <div className="mt-0.5 flex items-center gap-2 border-t border-border pt-2.5">
        <span className="text-xs text-subtle tabular-nums" data-testid="pr-filter-shown">
          {t('pr.narrow.shown', { shown, total: items.length })}
        </span>
        <button
          type="button"
          disabled={!isNarrowed(value)}
          onClick={() => onChange(clearNarrowing(value))}
          className="ml-auto inline-flex h-6 items-center rounded-sm px-2 text-sm text-muted hover:bg-surface-hover hover:text-text disabled:pointer-events-none disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          {t('pr.narrow.clear')}
        </button>
      </div>
    </div>
  )
}
