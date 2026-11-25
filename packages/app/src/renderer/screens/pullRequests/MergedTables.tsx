import type { ReactNode } from 'react'
import { seriesColor } from '../../components/molecules/StackedBarChart'
import { useI18n } from '../../i18n/I18nProvider'
import { cn } from '../../lib/cn'
import { coverage, GROUP_LABEL, GROUP_SLOT, type BranchRow, type RepoRow } from '../../lib/mergedStats'

const TH = 'px-3 py-2 text-left text-xs font-medium text-subtle'
const TD = 'px-3 py-2 whitespace-nowrap'

/** `+adds −dels`, or a dash when nothing reported them; a partial sum is still shown. */
export function Lines({ additions, deletions, reported, count }: { additions: number; deletions: number; reported: number; count: number }) {
  const { t, formatNumber } = useI18n()
  if (coverage(count, reported) === 'none') return <span className="text-subtle">{t('pr.merged.noData')}</span>
  return (
    <span className="whitespace-nowrap tabular-nums">
      <span className="text-success">+{formatNumber(additions)}</span> <span className="text-danger">−{formatNumber(deletions)}</span>
    </span>
  )
}

/** The bar of a table row: its length relative to the largest row, like the Usage share bars. */
function Bar({ value, max, color }: { value: number; max: number; color: string }) {
  return <span className="block h-2 min-w-0.5 rounded-r" style={{ width: `${Math.max(2, max > 0 ? (value / max) * 90 : 0)}px`, background: color }} aria-hidden />
}

function Frame({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-surface">
      <table aria-label={label} className="w-full border-collapse text-sm">
        {children}
      </table>
    </div>
  )
}

/** Merged per target group: release branches indented under `release/*` when there is more than one. */
export function BranchTable({ rows, total }: { rows: BranchRow[]; total: number }) {
  const { t, formatNumber } = useI18n()
  const max = Math.max(0, ...rows.filter((r) => !r.branch).map((r) => r.count))
  const percent = (n: number) => formatNumber(total > 0 ? n / total : 0, { style: 'percent', maximumFractionDigits: 0 })
  // No row reporting file counts (GitHub's merged search leaves them out): the column is left out.
  const showFiles = rows.some((r) => r.withFiles > 0)
  return (
    <Frame label={t('pr.merged.byBranch')}>
      <thead>
        <tr className="border-b border-border">
          <th scope="col" className={TH}>{t('pr.merged.col.into')}</th>
          <th scope="col" className={TH}>{t('pr.merged.col.merged')}</th>
          <th scope="col" className={cn(TH, 'text-right')}>{t('pr.merged.col.lines')}</th>
          {showFiles && <th scope="col" className={cn(TH, 'text-right')}>{t('pr.merged.col.files')}</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} className="border-b border-border last:border-b-0" data-testid="merged-branch-row">
            <th scope="row" className={cn(TD, 'text-left font-normal')}>
              <span className={cn('flex items-center gap-2 font-mono text-xs', r.branch && 'pl-5')}>
                <span className="size-2.5 shrink-0 rounded-sm" style={{ background: seriesColor(GROUP_SLOT[r.group]) }} aria-hidden />
                {r.branch ?? t(GROUP_LABEL[r.group])}
              </span>
            </th>
            <td className={TD}>
              <span className="flex items-center gap-2">
                <Bar value={r.count} max={max} color={seriesColor(GROUP_SLOT[r.group])} />
                <span className="tabular-nums">{formatNumber(r.count)}</span>
                <span className="text-subtle tabular-nums">{percent(r.count)}</span>
              </span>
            </td>
            <td className={cn(TD, 'text-right')}>
              <Lines additions={r.additions} deletions={r.deletions} reported={r.withLines} count={r.count} />
            </td>
            {showFiles && <td className={cn(TD, 'text-right tabular-nums')}>{coverage(r.count, r.withFiles) === 'none' ? <span className="text-subtle">{t('pr.merged.noData')}</span> : formatNumber(r.files)}</td>}
          </tr>
        ))}
      </tbody>
    </Frame>
  )
}

/** Merged per repository (`owner/repo`), most merged first, with the median open → merged. */
export function RepoTable({ rows }: { rows: RepoRow[] }) {
  const { t, tn, formatNumber } = useI18n()
  const max = Math.max(0, ...rows.map((r) => r.count))
  return (
    <Frame label={t('pr.merged.byRepo')}>
      <thead>
        <tr className="border-b border-border">
          <th scope="col" className={TH}>{t('pr.merged.col.repo')}</th>
          <th scope="col" className={TH}>{t('pr.merged.col.merged')}</th>
          <th scope="col" className={cn(TH, 'text-right')}>{t('pr.merged.col.lines')}</th>
          <th scope="col" className={cn(TH, 'text-right')}>{t('pr.merged.col.lead')}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} className="border-b border-border last:border-b-0" data-testid="merged-repo-row">
            <th scope="row" className={cn(TD, 'text-left font-mono text-xs font-normal')}>{r.key}</th>
            <td className={TD}>
              <span className="flex items-center gap-2">
                <Bar value={r.count} max={max} color="var(--wh-border-strong)" />
                <span className="tabular-nums">{formatNumber(r.count)}</span>
              </span>
            </td>
            <td className={cn(TD, 'text-right')}>
              <Lines additions={r.additions} deletions={r.deletions} reported={r.withLines} count={r.count} />
            </td>
            <td className={cn(TD, 'text-right tabular-nums')}>
              {r.leadMedianDays === null ? <span className="text-subtle">{t('pr.merged.noData')}</span> : tn('pr.merged.days', r.leadMedianDays, { count: formatNumber(r.leadMedianDays, { maximumFractionDigits: 1 }) })}
            </td>
          </tr>
        ))}
      </tbody>
    </Frame>
  )
}
