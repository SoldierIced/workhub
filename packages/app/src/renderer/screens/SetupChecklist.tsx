import { CircleCheck, CircleDashed, CircleX, TriangleAlert } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { problemCount, type SetupFix, type SetupItem } from '@workhub/core'
import { Button, Spinner } from '../components/atoms'
import { Dialog, useToast } from '../components/molecules'
import { useI18n } from '../i18n/I18nProvider'
import { cn } from '../lib/cn'
import { fixLabel, itemDetail, itemTitle, type SetupState } from '../lib/setup'

function StatusIcon({ item }: { item: SetupItem }) {
  if (item.status === 'ok') return <CircleCheck className="size-4 text-success" aria-hidden />
  if (item.status === 'warning') return <TriangleAlert className="size-4 text-warning" aria-hidden />
  return item.optional ? <CircleDashed className="size-4 text-subtle" aria-hidden /> : <CircleX className="size-4 text-danger" aria-hidden />
}

function Row({ item, onInstalled }: { item: SetupItem; onInstalled: () => void }) {
  const { t, tn } = useI18n()
  const toast = useToast()
  const [confirming, setConfirming] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const install = (fix: Extract<SetupFix, { kind: 'install' }>) => {
    setInstalling(true)
    setFailure(null)
    window.hub.setup.install(fix.installer).then(
      (result) => {
        setInstalling(false)
        if (result.ok) onInstalled()
        else setFailure(result.output.trim() || t('setup.install.noOutput'))
      },
      (error: unknown) => {
        setInstalling(false)
        setFailure(error instanceof Error ? error.message : String(error))
      }
    )
  }
  const perform = (fix: SetupFix) => {
    if (fix.kind === 'install') setConfirming(true)
    else if (fix.kind === 'settings') window.hub.setup.openSettings(fix.tab)
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
        {(item.fix?.kind === 'command' || item.fix?.kind === 'install') && <code className="mt-1 block truncate rounded-sm bg-surface-hover px-2 py-1 text-xs text-muted">{item.fix.command}</code>}
        {failure !== null && (
          <div role="alert" className="mt-2 text-sm text-danger">
            <p>{t('setup.install.failed')}</p>
            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-sm bg-surface-hover p-2 text-xs text-text">{failure}</pre>
          </div>
        )}
      </div>
      {item.fix && item.status !== 'ok' && (
        <Button size="sm" className="shrink-0" disabled={installing} onClick={() => perform(item.fix!)}>
          {installing ? t('setup.installing') : fixLabel(t, item.fix)}
        </Button>
      )}
      {installing && <Spinner />}
      {item.fix?.kind === 'install' && (
        <Dialog
          open={confirming}
          onOpenChange={setConfirming}
          title={t('setup.install.title', { name: itemTitle(t, item) })}
          description={t('setup.install.body')}
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirming(false)}>
                {t('common.cancel')}
              </Button>
              <Button
                autoFocus
                data-testid="setup-install-confirm"
                onClick={() => {
                  setConfirming(false)
                  install(item.fix as Extract<SetupFix, { kind: 'install' }>)
                }}
              >
                {t('setup.install.run')}
              </Button>
            </>
          }
        >
          <code className="block rounded-sm bg-surface-hover px-2 py-1.5 text-xs break-all">{item.fix.command}</code>
        </Dialog>
      )}
    </li>
  )
}

function Section({ title, items, onInstalled }: { title: string; items: SetupItem[]; onInstalled: () => void }) {
  if (items.length === 0) return null
  return (
    <section className="flex flex-col gap-2">
      <h2 className="px-1 text-md font-semibold">{title}</h2>
      <ul className="divide-y divide-border rounded-lg border border-border bg-surface shadow-sm">
        {items.map((i) => (
          <Row key={i.id} item={i} onInstalled={onInstalled} />
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
      <Section title={t('setup.required')} items={items.filter((i) => !i.optional)} onInstalled={run} />
      <Section title={t('setup.optional')} items={items.filter((i) => i.optional)} onInstalled={run} />
    </div>
  )
}
