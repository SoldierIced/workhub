import { HardDrive } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { StorageGroupName, StorageUsage } from '@shared/api'
import { Button, Spinner } from '../../components/atoms'
import { useToast } from '../../components/molecules'
import { useI18n } from '../../i18n/I18nProvider'
import type { MessageKey } from '../../i18n/translate'
import { errorText } from '../../lib/errorText'
import { formatBytes } from '../../lib/localReview'

const GROUP_LABEL: Record<StorageGroupName, MessageKey> = {
  usageDetail: 'storage.group.usageDetail',
  usageSummaries: 'storage.group.usageSummaries',
  historyIndex: 'storage.group.historyIndex',
  events: 'storage.group.events',
  pullRequests: 'storage.group.pullRequests',
  state: 'storage.group.state'
}

/** Rows and size per group of data, the retention rule and Compact now (Settings → Advanced → Data). */
export function StorageUsageRow({ onCompacted }: { onCompacted?: () => void }) {
  const { t, locale } = useI18n()
  const toast = useToast()
  const [usage, setUsage] = useState<StorageUsage | null>(null)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const load = () =>
    window.hub.storage.usage().then(
      (u) => {
        setUsage(u)
        setFailed(false)
      },
      (e: unknown) => {
        console.warn('[storage] usage failed', errorText(e))
        setFailed(true)
      }
    )
  useEffect(() => void load(), [])
  const compact = async () => {
    setBusy(true)
    try {
      const r = await window.hub.storage.compact()
      if (r.ok) toast(t('storage.compacted', { before: formatBytes(r.beforeBytes, locale), after: formatBytes(r.afterBytes, locale) }))
      else {
        console.warn('[storage] compact failed', r.error)
        toast(t('storage.compactFailed'), 'danger')
      }
    } catch (e) {
      console.warn('[storage] compact failed', errorText(e))
      toast(t('storage.compactFailed'), 'danger')
    } finally {
      setBusy(false)
      onCompacted?.()
      void load()
    }
  }
  const count = new Intl.NumberFormat(locale)
  return (
    <div className="py-3" data-settings-row data-testid="storage-usage">
      <div className="flex items-start gap-3">
        <HardDrive className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
        <div className="min-w-0 flex-1">
          <span className="block text-base">{t('storage.usage')}</span>
          <p className="text-xs text-subtle">{t('storage.retention', { months: usage?.retentionMonths ?? 12 })}</p>
          {failed && <p className="mt-1 text-xs text-danger">{t('storage.usageFailed')}</p>}
          {!usage && !failed && <Spinner />}
          {usage && (
            <table className="mt-2 text-xs">
              <tbody>
                {usage.groups.map((g) => (
                  <tr key={g.group} data-testid={`storage-group-${g.group}`}>
                    <td className="pr-4 text-muted">{t(GROUP_LABEL[g.group])}</td>
                    <td className="pr-4 text-right tabular-nums">{t('storage.rows', { count: count.format(g.rows) })}</td>
                    <td className="text-right tabular-nums">{g.bytes === null ? t('storage.sizeUnknown') : formatBytes(g.bytes, locale)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {usage && (
            <p className="mt-1 text-xs text-muted">
              {usage.freeBytes !== null && t('storage.free', { size: formatBytes(usage.freeBytes, locale) })}
              {usage.freeBytes !== null && usage.lastRunAt !== null && ' · '}
              {usage.lastRunAt !== null && t('storage.lastRun', { date: new Date(usage.lastRunAt).toLocaleString(locale) })}
            </p>
          )}
          <p className="mt-1 text-xs text-subtle">{t('storage.compactHint')}</p>
        </div>
        <Button size="sm" className="shrink-0" disabled={busy} aria-busy={busy} onClick={() => void compact()} data-testid="storage-compact">
          {busy ? t('storage.compacting') : t('storage.compactNow')}
        </Button>
      </div>
    </div>
  )
}
