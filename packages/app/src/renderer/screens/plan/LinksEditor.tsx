import { Plus, Trash2 } from 'lucide-react'
import { PLAN_LINK_LIMITS } from '@workhub/core'
import { Button, Input } from '../../components/atoms'
import { useI18n } from '../../i18n/I18nProvider'
import type { LinkRow } from '../../lib/planner'

/** The links of an inbox item or milestone as rows of label and address, with add and remove. */
export function LinksEditor({ rows, onChange }: { rows: LinkRow[]; onChange: (rows: LinkRow[]) => void }) {
  const { t } = useI18n()
  const set = (index: number, patch: Partial<LinkRow>) => onChange(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)))
  return (
    <div className="flex flex-col gap-2" role="group" aria-label={t('planner.links.title')}>
      {rows.map((row, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input value={row.label} onChange={(e) => set(i, { label: e.target.value })} placeholder={t('planner.links.labelPlaceholder')} aria-label={t('planner.links.label', { n: i + 1 })} maxLength={PLAN_LINK_LIMITS.label} className="w-40 shrink-0" />
          <Input value={row.url} onChange={(e) => set(i, { url: e.target.value })} placeholder="https://" aria-label={t('planner.links.url', { n: i + 1 })} maxLength={PLAN_LINK_LIMITS.url} spellCheck={false} className="min-w-0 flex-1" />
          <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" aria-hidden />} aria-label={t('planner.links.remove', { n: i + 1 })} title={t('planner.links.remove', { n: i + 1 })} onClick={() => onChange(rows.filter((_r, j) => j !== i))} />
        </div>
      ))}
      <div>
        <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" aria-hidden />} disabled={rows.length >= PLAN_LINK_LIMITS.items} onClick={() => onChange([...rows, { label: '', url: '' }])}>
          {t('planner.links.add')}
        </Button>
      </div>
    </div>
  )
}
