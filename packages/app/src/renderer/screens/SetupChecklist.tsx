import { CircleCheck, CircleDashed, CircleX, TriangleAlert } from 'lucide-react'
import type { ReactNode } from 'react'
import { problemCount, type SetupFix, type SetupItem } from '@workhub/core'
import { Button, Spinner } from '../components/atoms'
import { useToast } from '../components/molecules'
import { useI18n } from '../i18n/I18nProvider'
import { cn } from '../lib/cn'
import { fixLabel, itemDetail, itemTitle, type SetupState } from '../lib/setup'

function StatusIcon({ item }: { item: SetupItem }) {
  if (item.status === 'ok') return <CircleCheck className="size-4 text-success" aria-hidden />
  if (item.status === 'warning') return <TriangleAlert className="size-4 text-warning" aria-hidden />
  return item.optional ? <CircleDashed className="size-4 text-subtle" aria-hidden /> : <CircleX className="size-4 text-danger" aria-hidden />
}

function Row({ item }: { item: SetupItem }) {
  const { t, tn } = useI18n()
  const toast = useToast()
  const perform = (fix: SetupFix) => {
    if (fix.kind === 'settings') window.hub.setup.openSettings(fix.tab)
    else if (fix.kind === 'link') window.hub.openExternal(fix.url)
    else void navigator.clipboard.writeText(fix.command).then(() => toast(t('setup.copied')))
  }
  const status = item.status === 'ok' ? t('setup.statusOk') : item.status === 'warning' ? t('setup.statusWarning') : item.optional ? t('setup.statusOptionalMissing') : t('setup.statusMissing')
  return (
    <li className="flex items-start gap-3 px-4 py-3" data-testid={`setup-row-${item.id}`}>
      <span className="mt-0.5" role="img" aria-label={status}>
        <StatusIcon item={item} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-base font-medium">{itemTitle(t, item)}</p>
        <p className={cn('text-sm', item.status === 'ok' ? 'text-muted' : 'text-text')}>{itemDetail(t, tn, item)}</p>
        {item.fix?.kind === 'command' && <code className="mt-1 block truncate rounded-sm bg-surface-hover px-2 py-1 text-xs text-muted">{item.fix.command}</code>}
      </div>
      {item.fix && item.status !== 'ok' && (
        <Button size="sm" className="shrink-0" onClick={() => perform(item.fix!)}>
          {fixLabel(t, item.fix)}
        </Button>
      )}
    </li>
  )
}

function Section({ title, items }: { title: string; items: SetupItem[] }) {
  if (items.length === 0) return null
  return (
    <section className="flex flex-col gap-2">
      <h2 className="px-1 text-md font-semibold">{title}</h2>
      <ul className="divide-y divide-border rounded-lg border border-border bg-surface shadow-sm">
        {items.map((i) => (
          <Row key={i.id} item={i} />
        ))}
      </ul>
    </section>
  )
}

/** The rows of the setup check, needed first, then the optional ones, with a summary line and "Check again". */
export function SetupChecklist({ state, actions }: { state: SetupState; actions?: ReactNode }) {
  const { t, tn } = useI18n()
  const { items, running, failed, run } = state
  const problems = problemCount(items)
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-3">
        <p role="status" className="min-w-0 flex-1 text-base">
          {running ? t('setup.checking') : failed ? t('setup.failed') : problems === 0 ? t('setup.allGood') : tn('setup.problems', problems)}
        </p>
        {running && <Spinner />}
        {actions}
        <Button size="sm" disabled={running} onClick={run}>
          {t('setup.checkAgain')}
        </Button>
      </div>
      <Section title={t('setup.required')} items={items.filter((i) => !i.optional)} />
      <Section title={t('setup.optional')} items={items.filter((i) => i.optional)} />
    </div>
  )
}
