import { CircleAlert, Download, KeyRound } from 'lucide-react'
import { useState } from 'react'
import { isEmptyImportPlan, type ImportNote, type ImportPlan, type ImportPrefs, type Result, type WorkhubConfig } from '@workhub/core'
import { useI18n } from '../../i18n/I18nProvider'
import { readPrefs, setPrefs } from '../../lib/prefs'
import type { MessageKey } from '../../i18n/translate'
import { Badge } from '../atoms/Badge'
import { Button } from '../atoms/Button'
import { Spinner } from '../atoms/Spinner'
import { Workhub1SecretsImport } from './Workhub1SecretsImport'

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
  return isEmptyImportPlan(plan)
}

/** Paths that have their own preview row; notes on any other path are listed under "Not carried over". */
export function rowPaths(plan: ImportPlan): Set<string> {
  return new Set([
    ...plan.profiles.map((p) => `profiles.${p.id}`),
    ...plan.accounts.map((a) => `accounts.${a.id}`),
    ...plan.connections.map((c) => `connections.${c.id}`),
    ...(plan.automations ?? []).map((a) => `automations.${a.id}`),
    ...(plan.chatWatcher ? ['chatWatcher'] : [])
  ])
}

/**
 * The renderer-only preferences of the import: a model already picked for an agent and a language
 * already chosen win over Workhub 1's.
 */
export function mergedPrefs(current: { language: string; models: Record<string, string> }, imported: ImportPrefs | undefined): { language?: 'en' | 'es'; models?: Record<string, string> } {
  const out: { language?: 'en' | 'es'; models?: Record<string, string> } = {}
  if (imported?.models) out.models = { ...imported.models, ...current.models }
  if (imported?.language && current.language === 'system') out.language = imported.language
  return out
}

const MODULES: [keyof ImportPlan['profiles'][number]['modules'], MessageKey][] = [
  ['chatWatcher', 'nav.slack'],
  ['automations', 'nav.automations'],
  ['health', 'nav.health']
]

type Translate = (key: MessageKey, params?: Record<string, string>) => string

/** One row per app-wide part of the plan: options, sidebar groups, model per account, language. */
export function optionRows(plan: ImportPlan, t: Translate): { id: string; name: string; meta?: string; notes: ImportNote[] }[] {
  const rows: { id: string; name: string; meta?: string; notes: ImportNote[] }[] = []
  const o = plan.options
  if (o) {
    const parts: string[] = []
    if (o.claudePlanUsage) parts.push(t('import.optPlanUsage'))
    if (o.notifyPrEvents && Object.values(o.notifyPrEvents).every((v) => !v)) parts.push(t('import.optPrEventsOff'))
    if (o.notifyReplied === false || o.notifyNeedsAnswer === false) parts.push(t('import.optSessionNotificationsOff'))
    rows.push({ id: 'options', name: t('import.optionsRow'), meta: parts.join(', '), notes: notesFor(plan, 'options') })
  }
  const groups = plan.sessionGroups
  if (groups && (groups.groups.length || groups.top.length)) {
    const sessions = new Set([...groups.groups.flatMap((g) => g.members.map((m) => m.key)), ...groups.top.flatMap((s) => (s.kind === 'session' ? [s.key] : []))])
    rows.push({ id: 'sessionGroups', name: t('import.sessionGroups'), meta: t('import.sessionGroupsMeta', { groups: String(groups.groups.length), sessions: String(sessions.size) }), notes: notesFor(plan, 'sessionGroups') })
  }
  const models = Object.values(plan.prefs?.models ?? {})
  if (models.length) rows.push({ id: 'models', name: t('import.defaultModel'), meta: models.join(', '), notes: [] })
  if (plan.prefs?.language) rows.push({ id: 'language', name: t('import.language'), meta: plan.prefs.language, notes: [] })
  return rows
}

/** Notes that belong to no preview row (app-wide Workhub 1 settings), "already here" ones aside. */
export function otherNotes(plan: ImportPlan): ImportNote[] {
  const rows = rowPaths(plan)
  return plan.notes.filter((n) => n.code !== 'exists' && !rows.has(n.path))
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

  const apply = async (plan: ImportPlan) => {
    if (await run(() => window.hub.config.applyWorkhub1Import())) {
      const prefs = mergedPrefs(readPrefs(), plan.prefs)
      if (prefs.models || prefs.language) setPrefs(prefs)
      setState({ kind: 'done' })
    }
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
      <Workhub1SecretsImport />
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
                rows={state.plan.profiles.map((p) => ({
                  id: p.id,
                  name: p.name,
                  meta: [(p.folders ?? []).join(', '), MODULES.filter(([m]) => p.modules[m]).map(([, k]) => t(k)).join(', ')].filter(Boolean).join(' · '),
                  notes: notesFor(state.plan, `profiles.${p.id}`)
                }))}
              />
              <Group
                title={t('settings.accounts')}
                rows={state.plan.accounts.map((a) => ({ id: a.id, name: a.name, meta: a.configDir ?? t('import.defaultFolder'), notes: notesFor(state.plan, `accounts.${a.id}`) }))}
              />
              <Group
                title={t('settings.connections')}
                rows={state.plan.connections.map((c) => ({ id: c.id, name: c.name || c.id, meta: c.endpoint, notes: notesFor(state.plan, `connections.${c.id}`) }))}
              />
              <Group
                title={t('nav.automations')}
                rows={(state.plan.automations ?? []).map((a) => ({ id: a.id, name: a.name, meta: [a.folder, a.prompt].filter(Boolean).join(' · '), notes: notesFor(state.plan, `automations.${a.id}`) }))}
              />
              <Group
                title={t('nav.slack')}
                rows={
                  state.plan.chatWatcher
                    ? [
                        {
                          id: 'chatWatcher',
                          name: t(state.plan.chatWatcher.enabled ? 'import.watcherOn' : 'import.watcherOff'),
                          meta: t('import.channels', { count: String(state.plan.chatWatcher.channels.length) }),
                          notes: notesFor(state.plan, 'chatWatcher')
                        }
                      ]
                    : []
                }
              />
              <Group title={t('import.options')} rows={optionRows(state.plan, t)} />
            </>
          )}
          {otherNotes(state.plan).length > 0 && (
            <div>
              <h4 className="text-xs font-semibold tracking-wide text-subtle uppercase">{t('import.notCarried')}</h4>
              <ul className="mt-1.5 flex flex-col gap-1">
                {otherNotes(state.plan).map((n, i) => (
                  <li key={i} className="text-xs text-subtle" data-testid="import-note">
                    {t(NOTE_LABEL[n.code], { detail: n.detail ?? n.path })}
                  </li>
                ))}
              </ul>
            </div>
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
            <Button size="sm" variant="primary" disabled={isEmptyPlan(state.plan)} onClick={() => void apply(state.plan)}>
              {t('import.apply')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
