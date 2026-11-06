import { ChevronDown, ChevronRight, Plus } from 'lucide-react'
import { useEffect, useId, useState, type ReactNode } from 'react'
import type { ConnectionKind, OfferedModule, Profile, ValidationIssue, WorkhubConfig } from '@workhub/core'
import type { ConfigSnapshot } from '@shared/api'
import { Button } from '../../components/atoms'
import { Card, CardBody, CardHeader, EmptyState, HelpTip, ListRow } from '../../components/molecules'
import { useUnsavedChanges } from '../../components/organisms/UnsavedChanges'
import { useI18n } from '../../i18n/I18nProvider'
import type { MessageKey } from '../../i18n/translate'
import { friendlyIssue } from '../../lib/configIssues'
import type { Run } from './run'

export const KIND_LABEL: Record<ConnectionKind, MessageKey> = {
  codeHost: 'kind.codeHost',
  tracker: 'kind.tracker',
  chat: 'kind.chat',
  health: 'kind.health',
  calendar: 'kind.calendar'
}

export const MODULE_LABEL: Record<OfferedModule, MessageKey> = {
  health: 'module.health',
  chatWatcher: 'module.chatWatcher',
  automations: 'module.automations',
  flowMaps: 'module.flowMaps',
  planner: 'module.planner'
}

export interface SectionProps {
  snap: ConfigSnapshot
  run: Run
}

/** `KEY=value` per line <-> record. */
export const toLines = (m: Record<string, string> | undefined) =>
  Object.entries(m ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
export const fromLines = (text: string): Record<string, string> =>
  Object.fromEntries(
    text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const i = l.indexOf('=')
        return i < 0 ? [l, ''] : [l.slice(0, i).trim(), l.slice(i + 1)]
      })
  )

/** The profiles that use a connection (one of their picks, or a Plan calendar). */
export function connectionUsers(config: WorkhubConfig, connectionId: string): Profile[] {
  return config.profiles.filter((p) => Object.values(p.connections).includes(connectionId) || (p.planner?.calendarIds ?? []).includes(connectionId))
}

/** The problems of the last refused save, in plain words. */
export function Issues({ issues, title }: { issues: ValidationIssue[]; title?: string }) {
  const { t } = useI18n()
  if (!issues.length) return null
  return (
    <div role="alert" className="rounded-lg border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger">
      {title && <p className="mb-1 font-semibold">{title}</p>}
      <ul className="flex flex-col gap-0.5">
        {[...new Set(issues.map((i) => friendlyIssue(i, (k, p) => t(k, p))))].map((text) => (
          <li key={text}>{text}</li>
        ))}
      </ul>
    </div>
  )
}

/** A titled box of fields inside a form. */
export function FieldGroup({ legend, help, children }: { legend: string; help?: ReactNode; children: ReactNode }) {
  return (
    <fieldset className="rounded-md border border-border px-3 pt-1 pb-2" data-settings-row>
      <legend className="flex items-center gap-1.5 px-1 text-sm font-medium text-muted">
        {legend}
        {help && <HelpTip text={help} label={legend} />}
      </legend>
      {children}
    </fieldset>
  )
}

/** Left: the items with a New button. Right: the form of the selected (or new) item. */
export function MasterDetail<T extends { id: string }>(props: {
  title: string
  newLabel: string
  emptyLabel: string
  items: T[]
  selected: string | null
  label: (item: T) => string
  meta?: (item: T) => ReactNode
  onSelect: (id: string | null) => void
  formTitle: string
  form: ReactNode
  /** Actions on the selected item (make active, delete), next to its name; none for an entry that is only shown (an agent's own sign-in). Saving is the save bar's. */
  headerActions?: ReactNode
}) {
  // Picking another item (or New) asks first when the form has unsaved changes.
  const unsaved = useUnsavedChanges()
  const pick = (id: string | null) => unsaved.requestLeave(() => props.onSelect(id))
  return (
    <div className="grid items-start gap-4 xl:grid-cols-[15rem_minmax(0,1fr)]">
      <Card>
        <CardHeader
          title={props.title}
          as="h2"
          actions={
            <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" aria-hidden />} onClick={() => pick(null)}>
              {props.newLabel}
            </Button>
          }
        />
        <CardBody className="px-2 pb-2">
          {props.items.length === 0 ? (
            <EmptyState compact title={props.emptyLabel} />
          ) : (
            <ul className="flex flex-col gap-0.5">
              {props.items.map((i) => (
                <li key={i.id}>
                  <ListRow title={props.label(i)} trailing={props.meta?.(i)} selected={props.selected === i.id} onClick={() => pick(i.id)} />
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
      <Card>
        <CardHeader title={props.formTitle} as="h2" actions={props.headerActions} />
        <CardBody className="flex flex-col gap-4">{props.form}</CardBody>
      </Card>
    </div>
  )
}

/**
 * Saves one part of a profile: the profile is read again first, so two sections saved by one save
 * bar (modules, then AI review) never undo each other.
 */
export function saveProfilePatch(run: Run, profileId: string, patch: (p: Profile) => Profile): Promise<boolean> {
  return run(async () => {
    const latest = (await window.hub.config.get()).config.profiles.find((p) => p.id === profileId)
    if (!latest) return { ok: false, issues: [{ path: `profiles.${profileId}`, message: 'not found' }] }
    return window.hub.config.saveProfile(patch(latest))
  })
}

/** Shown by a section of a module that is off for the profile: the module is turned on in Modules and screens. */
export function ModuleOffNote({ module, onOpenModules }: { module: OfferedModule; onOpenModules: () => void }) {
  const { t } = useI18n()
  return (
    <div className="flex items-center gap-3 rounded-md bg-surface-raised px-3 py-2 text-sm text-muted" data-testid="settings-module-off">
      <span className="min-w-0 flex-1">{t('settings.moduleOff', { module: t(MODULE_LABEL[module]) })}</span>
      <Button size="sm" onClick={onOpenModules}>
        {t('settings.moduleOffAction')}
      </Button>
    </div>
  )
}

/**
 * A settings row that opens more settings under it: label and hint on the left; on the right a
 * summary of what is set, any `controls` (a switch, a select) and the button that opens it. The
 * content is mounted the first time it opens and kept while closed, so a draft in it survives.
 */
export function Disclosure({
  label,
  hint,
  summary,
  action,
  controls,
  open: controlled,
  onOpenChange,
  defaultOpen = false,
  testId,
  children
}: {
  label: ReactNode
  hint?: ReactNode
  summary?: ReactNode
  /** The button's text ("Adjust…"); a chevron alone when not given. */
  action?: string
  controls?: ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
  defaultOpen?: boolean
  testId?: string
  children: ReactNode
}) {
  const [own, setOwn] = useState(defaultOpen)
  const open = controlled ?? own
  const [mounted, setMounted] = useState(open)
  useEffect(() => {
    if (open) setMounted(true)
  }, [open])
  const id = useId()
  const toggle = () => {
    setOwn(!open)
    onOpenChange?.(!open)
  }
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <div data-testid={testId}>
      <div className="flex items-center justify-between gap-6 py-3" data-settings-row>
        <div className="min-w-0">
          <span className="block text-base">{label}</span>
          {hint && <p className="text-xs text-subtle">{hint}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {summary && <span className="max-w-64 truncate text-sm text-muted">{summary}</span>}
          {controls}
          <Button size="sm" variant="ghost" aria-expanded={open} aria-controls={id} aria-label={action ? undefined : typeof label === 'string' ? label : undefined} onClick={toggle} icon={<Chevron className="size-3.5" aria-hidden />} data-testid={testId ? `${testId}-toggle` : undefined}>
            {action}
          </Button>
        </div>
      </div>
      {mounted && (
        <div id={id} hidden={!open}>
          {children}
        </div>
      )}
    </div>
  )
}

/** Shown in a profile section while the profile picker is on "New profile". */
export function NoProfileYet() {
  const { t } = useI18n()
  return <EmptyState compact title={t('settings.profileFirst')} />
}
