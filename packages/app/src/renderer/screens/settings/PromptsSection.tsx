import { useEffect, useMemo, useState } from 'react'
import { appOptions, MAX_PROMPT_LENGTH, PROMPT_AREAS, PROMPT_IDS, promptDefinition, promptIssues, type PromptArea, type PromptId } from '@workhub/core'
import { Badge, Button, Textarea } from '../../components/atoms'
import { EmptyState } from '../../components/molecules'
import { useUnsavedForm } from '../../components/organisms/UnsavedChanges'
import { useI18n } from '../../i18n/I18nProvider'
import { DICTIONARIES, type MessageKey } from '../../i18n/translate'
import { overridesFor, shownDefault, shownTexts, unsavable } from '../../lib/promptSettings'
import { isDirty, type SaveOutcome } from '../../lib/unsavedChanges'
import { SettingsGroup } from './SettingsLayout'
import { Disclosure, type SectionProps } from './shared'

const AREA_LABEL: Record<PromptArea, MessageKey> = {
  review: 'prompts.area.review',
  continuity: 'prompts.area.continuity',
  listen: 'prompts.area.listen',
  chat: 'prompts.area.chat',
  sessions: 'prompts.area.sessions',
  links: 'prompts.area.links',
  health: 'prompts.area.health'
}

/** A per-prompt key (`prompts.<id>.name|when|fixed`), or undefined when the prompt has none. */
const promptKey = (id: PromptId, part: 'name' | 'when' | 'fixed'): MessageKey | undefined => {
  const key = `prompts.${id}.${part}`
  return Object.hasOwn(DICTIONARIES.en, key) ? (key as MessageKey) : undefined
}

/**
 * Settings → Prompts: every instruction Workhub writes to an agent, by area. One form: the save bar
 * stores only the texts that differ from their default, and refuses while one would lose a slot or
 * names a placeholder the prompt does not have.
 */
export function PromptsSection({ snap, run }: SectionProps) {
  const { t, locale } = useI18n()
  const editable = !snap.loadError
  const saved = appOptions(snap.config).prompts
  const baseline = useMemo(() => shownTexts(saved, locale), [saved, locale])
  const [draft, setDraft] = useState(baseline)
  useEffect(() => setDraft(baseline), [baseline])
  const name = (id: PromptId) => {
    const key = promptKey(id, 'name')
    return key ? t(key) : id
  }

  const save = async (): Promise<SaveOutcome> => {
    const bad = unsavable(draft, locale)
    if (bad.length) return { ok: false, problem: t('prompts.cannotSave', { names: bad.map((b) => name(b.id)).join(', ') }) }
    const ok = await run(() => window.hub.config.saveOptions({ prompts: overridesFor(saved, draft, locale, baseline) }))
    return ok ? { ok: true } : { ok: false }
  }
  useUnsavedForm({ dirty: isDirty(baseline, draft), draft, save, discard: () => setDraft(baseline) })

  if (PROMPT_IDS.length === 0) return <EmptyState compact title={t('prompts.none')} />
  return (
    <div className="flex flex-col gap-6" data-testid="settings-prompts">
      {PROMPT_AREAS.map((area) => {
        const ids = PROMPT_IDS.filter((id) => promptDefinition(id).area === area)
        if (!ids.length) return null
        return (
          <SettingsGroup key={area} anchor={area} title={t(AREA_LABEL[area])}>
            {ids.map((id) => (
              <PromptRow key={id} id={id} name={name(id)} text={draft[id]} editable={editable} edited={draft[id] !== shownDefault(id, locale)} onChange={(text) => setDraft((d) => ({ ...d, [id]: text }))} />
            ))}
          </SettingsGroup>
        )
      })}
      <p className="px-1 text-xs text-subtle">{t('prompts.elsewhere')}</p>
    </div>
  )
}

function PromptRow({ id, name, text, editable, edited, onChange }: { id: PromptId; name: string; text: string; editable: boolean; edited: boolean; onChange: (text: string) => void }) {
  const { t, locale } = useI18n()
  const def = promptDefinition(id)
  const fallback = shownDefault(id, locale)
  const issues = promptIssues(id, text, fallback)
  const when = promptKey(id, 'when')
  const fixed = promptKey(id, 'fixed')
  const list = (names: readonly string[]) => names.map((n) => `{${n}}`).join(', ')
  return (
    <Disclosure label={name} hint={when ? t(when) : undefined} summary={edited ? <Badge tone="info">{t('prompts.edited')}</Badge> : undefined} testId={`prompt-${id}`}>
      <div className="flex flex-col gap-2 pb-4">
        <Textarea rows={8} value={text} maxLength={MAX_PROMPT_LENGTH} spellCheck={false} disabled={!editable} aria-label={name} data-testid={`prompt-text-${id}`} onChange={(e) => onChange(e.target.value)} />
        {def.placeholders.length > 0 && <p className="text-xs text-subtle">{t('prompts.placeholders', { list: list(def.placeholders) })}</p>}
        {def.slots && def.slots.length > 0 && <p className="text-xs text-subtle">{t('prompts.slots', { list: list(def.slots) })}</p>}
        {issues.unknown.length > 0 && <p className="text-xs text-danger" role="alert">{t('prompts.unknown', { list: list(issues.unknown) })}</p>}
        {issues.missingSlots.length > 0 && <p className="text-xs text-danger" role="alert">{t('prompts.missingSlots', { list: list(issues.missingSlots) })}</p>}
        {issues.missingOptional.length > 0 && <p className="text-xs text-warning">{t('prompts.missingOptional', { list: list(issues.missingOptional) })}</p>}
        {fixed && <p className="text-xs text-subtle">{t('prompts.fixed', { what: t(fixed) })}</p>}
        <div>
          <Button size="sm" variant="ghost" disabled={!editable || !edited} aria-label={t('prompts.restoreNamed', { name })} onClick={() => onChange(fallback)}>
            {t('prompts.restore')}
          </Button>
        </div>
      </div>
    </Disclosure>
  )
}
