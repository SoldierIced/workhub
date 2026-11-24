import { CircleCheck, CircleDashed, CircleX, Clock, TriangleAlert } from 'lucide-react'
import type { ReactNode } from 'react'
import { missingInstallers, problemCount, setupGoal, type SetupFix, type SetupGoal, type SetupItem } from '@workhub/core'
import { Button, Select, Spinner } from '../components/atoms'
import { refreshConfig, useConfig } from '../configStore'
import { useToast } from '../components/molecules'
import { InstallAction } from '../components/organisms/InstallAction'
import { InstallMissing } from '../components/organisms/InstallMissing'
import { useI18n } from '../i18n/I18nProvider'
import { cn } from '../lib/cn'
import { fixLabel, itemDetail, itemTitle, type SetupState } from '../lib/setup'

function StatusIcon({ item }: { item: SetupItem }) {
  if (item.status === 'ok') return <CircleCheck className="size-4 text-success" aria-hidden />
  if (item.status === 'warning') return <TriangleAlert className="size-4 text-warning" aria-hidden />
  if (item.status === 'pending') return <Clock className="size-4 text-subtle" aria-hidden />
  return item.optional ? <CircleDashed className="size-4 text-subtle" aria-hidden /> : <CircleX className="size-4 text-danger" aria-hidden />
}

/** What a fix asks to run or read, under a row's detail: the command, and why Workhub does not run one that needs administrator rights. */
export function FixNotes({ fix }: { fix: SetupFix }) {
  const { t } = useI18n()
  return (
    <>
      {fix.kind === 'install' && fix.managed ? (
        // Workhub installs it itself: an `npm install` line would read as something to type, on a machine that may have no npm.
        <p className="mt-1 text-xs text-subtle">{t('setup.install.managedNote')}</p>
      ) : (
        (fix.kind === 'command' || fix.kind === 'install' || fix.kind === 'adminCommand') && <code className="mt-1 block truncate rounded-sm bg-surface-hover px-2 py-1 text-xs text-muted">{fix.command}</code>
      )}
      {(fix.kind === 'adminCommand' || (fix.kind === 'link' && fix.admin)) && (
        <p className="mt-1 text-xs text-subtle">
          {t(fix.kind === 'adminCommand' ? 'setup.adminCommand' : 'setup.adminPage')}{' '}
          {fix.kind === 'adminCommand' && (
            <button type="button" className="text-accent underline" onClick={() => window.hub.openExternal(fix.url)}>
              {t('setup.link.installPage')}
            </button>
          )}
        </p>
      )}
    </>
  )
}

/** The button of a fix: Install (asks first), Sign in (the in-app sign-in window), a Settings tab, a page, or Copy command. */
export function FixButton({ fix, name, onInstalled }: { fix: SetupFix; name: string; onInstalled: () => void }) {
  const { t } = useI18n()
  const toast = useToast()
  if (fix.kind === 'install') return <InstallAction fix={fix} name={name} onInstalled={onInstalled} />
  const perform = () => {
    if (fix.kind === 'settings') window.hub.setup.openSettings(fix.tab)
    else if (fix.kind === 'link') window.hub.openExternal(fix.url)
    else if (fix.kind === 'signIn') void window.hub.signIn(fix.tool, fix.accountId)
    else void navigator.clipboard.writeText(fix.command).then(() => toast(t('setup.copied')))
  }
  return (
    <Button size="sm" className="shrink-0" onClick={perform}>
      {fixLabel(t, fix)}
    </Button>
  )
}

/** One row of the setup check: its state, what was found, and its fix while it is not ready. */
export function SetupRow({ item, onInstalled }: { item: SetupItem; onInstalled: () => void }) {
  const { t, tn } = useI18n()
  const fix = item.fix
  const status = item.status === 'ok' ? t('setup.statusOk') : item.status === 'warning' ? t('setup.statusWarning') : item.status === 'pending' ? t('setup.statusPending') : item.optional ? t('setup.statusOptionalMissing') : t('setup.statusMissing')
  const open = fix && item.status !== 'ok'
  return (
    <li className="flex items-start gap-3 px-4 py-3" data-testid={`setup-row-${item.id}`}>
      <span className="mt-0.5" role="img" aria-label={status}>
        <StatusIcon item={item} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-base font-medium">{itemTitle(t, item)}</p>
        <p className={cn('text-sm', item.status === 'ok' ? 'text-muted' : 'text-text')}>{itemDetail(t, tn, item)}</p>
        {open && <FixNotes fix={fix} />}
      </div>
      {open && <FixButton fix={fix} name={itemTitle(t, item)} onInstalled={onInstalled} />}
    </li>
  )
}

const GOALS: readonly SetupGoal[] = ['files', 'code', 'both']

/** What the person wants Workhub for: the needed rows follow it. Saved in the app options. */
function GoalPicker({ onChanged }: { onChanged: () => void }) {
  const { t } = useI18n()
  const snap = useConfig()
  const goal = snap ? setupGoal(snap.config) : 'both'
  const choose = (value: string) => {
    const next = GOALS.find((g) => g === value)
    if (!next || next === goal) return
    void window.hub.config.saveOptions({ setupGoal: next }).then(async () => {
      await refreshConfig()
      onChanged()
    })
  }
  return (
    <label className="flex items-center gap-3">
      <span className="text-sm text-muted">{t('setup.goal.label')}</span>
      <Select aria-label={t('setup.goal.label')} value={goal} onChange={choose} options={GOALS.map((g) => ({ value: g, label: t(`setup.goal.${g}`) }))} className="max-w-xs" />
    </label>
  )
}

function Section({ title, items, onInstalled }: { title: string; items: SetupItem[]; onInstalled: () => void }) {
  if (items.length === 0) return null
  return (
    <section className="flex flex-col gap-2">
      <h2 className="px-1 text-md font-semibold">{title}</h2>
      <ul className="divide-y divide-border rounded-lg border border-border bg-surface shadow-sm">
        {items.map((i) => (
          <SetupRow key={i.id} item={i} onInstalled={onInstalled} />
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
      <GoalPicker onChanged={run} />
      <InstallMissing installers={missingInstallers(items)} busy={running} onDone={run} />
      <Section title={t('setup.required')} items={items.filter((i) => !i.optional)} onInstalled={run} />
      <Section title={t('setup.optional')} items={items.filter((i) => i.optional)} onInstalled={run} />
    </div>
  )
}
