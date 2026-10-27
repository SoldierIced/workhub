import { CircleAlert, Download, KeyRound } from 'lucide-react'
import { useState } from 'react'
import type { ImportNote, ImportPlan, Result, WorkhubConfig } from '@workhub/core'
import { useI18n } from '../../i18n/I18nProvider'
import type { MessageKey } from '../../i18n/translate'
import { Badge } from '../atoms/Badge'
import { Button } from '../atoms/Button'
import { Spinner } from '../atoms/Spinner'

const NOTE_LABEL: Record<ImportNote['code'], MessageKey> = {
  exists: 'import.noteExists',
  reenterSecret: 'import.noteReenter',
  notSupported: 'import.noteNotSupported'
}

/** Notes of one imported item (`profiles.work`), for the preview rows. */
export function notesFor(plan: ImportPlan, path: string): ImportNote[] {
  return plan.notes.filter((n) => n.path === path)
}

/** True when the plan adds nothing: every item already exists or nothing was found. */
export function isEmptyPlan(plan: ImportPlan): boolean {
  return plan.profiles.length === 0 && plan.accounts.length === 0 && plan.connections.length === 0
}

function Notes({ notes }: { notes: ImportNote[] }) {
  const { t } = useI18n()
  if (!notes.length) return null
  return (
    <span className="flex flex-wrap gap-1">
      {notes.map((n, i) => (
        <Badge key={i} tone={n.code === 'reenterSecret' ? 'warning' : 'neutral'} icon={n.code === 'reenterSecret' ? <KeyRound className="size-3" aria-hidden /> : undefined}>
          {t(NOTE_LABEL[n.code], { detail: n.detail ?? '' })}
        </Badge>
      ))}
    </span>
  )
}

function Group({ title, rows }: { title: string; rows: { id: string; name: string; meta?: string; notes: ImportNote[] }[] }) {
  if (!rows.length) return null
  return (
    <div>
      <h4 className="text-xs font-semibold tracking-wide text-subtle uppercase">{title}</h4>
      <ul className="mt-1.5 flex flex-col gap-1.5">
        {rows.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-2 text-sm" data-testid="import-row">
            <span className="font-medium">{r.name}</span>
            {r.meta && <span className="truncate font-mono text-xs text-subtle">{r.meta}</span>}
            <Notes notes={r.notes} />
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * Settings → General: reads Workhub 1's settings (read-only, macOS) and shows what would be
 * added before anything is saved. Secrets are never copied; the preview marks them "re-enter".
 */
export function Workhub1Import({ run }: { run: (op: () => Promise<Result<WorkhubConfig>>) => Promise<boolean> }) {
  const { t } = useI18n()
  const [state, setState] = useState<{ kind: 'idle' | 'loading' } | { kind: 'missing' } | { kind: 'error'; message: string } | { kind: 'plan'; plan: ImportPlan } | { kind: 'done' }>({ kind: 'idle' })

  const preview = async () => {
    setState({ kind: 'loading' })
    const r = await window.hub.config.previewWorkhub1Import()
    if (r.error) setState({ kind: 'error', message: r.error })
    else if (!r.available || !r.plan) setState({ kind: 'missing' })
    else setState({ kind: 'plan', plan: r.plan })
  }

  const apply = async () => {
    if (await run(() => window.hub.config.applyWorkhub1Import())) setState({ kind: 'done' })
  }

  return (
    <div className="flex flex-col gap-3 py-3" data-testid="workhub1-import">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-base">{t('import.title')}</div>
          <p className="text-xs text-subtle">{t('import.hint')}</p>
        </div>
        <Button size="sm" variant="secondary" icon={state.kind === 'loading' ? <Spinner className="size-3" /> : <Download className="size-3.5" aria-hidden />} disabled={state.kind === 'loading'} onClick={() => void preview()}>
          {t('import.preview')}
        </Button>
      </div>
      {state.kind === 'missing' && <p className="text-sm text-muted">{t('import.missing')}</p>}
      {state.kind === 'done' && <p className="text-sm text-success">{t('import.done')}</p>}
      {state.kind === 'error' && (
        <p role="alert" className="flex items-center gap-2 text-sm text-danger">
          <CircleAlert className="size-4 shrink-0" aria-hidden />
          {state.message}
        </p>
      )}
      {state.kind === 'plan' && (
        <div className="flex flex-col gap-3 rounded-md border border-border bg-bg p-3" aria-label={t('import.previewLabel')}>
          {isEmptyPlan(state.plan) ? (
            <p className="text-sm text-muted">{t('import.nothing')}</p>
          ) : (
            <>
              <Group
                title={t('settings.profiles')}
                rows={state.plan.profiles.map((p) => ({ id: p.id, name: p.name, meta: (p.folders ?? []).join(', '), notes: notesFor(state.plan, `profiles.${p.id}`) }))}
              />
              <Group
                title={t('settings.accounts')}
                rows={state.plan.accounts.map((a) => ({ id: a.id, name: a.name, meta: a.configDir ?? t('import.defaultFolder'), notes: notesFor(state.plan, `accounts.${a.id}`) }))}
              />
              <Group
                title={t('settings.connections')}
                rows={state.plan.connections.map((c) => ({ id: c.id, name: c.name || c.id, meta: c.endpoint, notes: notesFor(state.plan, `connections.${c.id}`) }))}
              />
            </>
          )}
          {state.plan.notes
            .filter((n) => n.code === 'exists')
            .map((n) => (
              <p key={n.path} className="text-xs text-subtle">
                {t('import.skipped', { item: n.path })}
              </p>
            ))}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setState({ kind: 'idle' })}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" variant="primary" disabled={isEmptyPlan(state.plan)} onClick={() => void apply()}>
              {t('import.apply')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
