import { Input, Textarea } from '../../components/atoms'
import { Field } from '../../components/molecules'
import { useI18n } from '../../i18n/I18nProvider'
import type { PersonForm } from '../../lib/plan'

/** The fields of one person: name, the addresses that match them to attendees, their handles and notes. */
export function PersonFields({ form, onChange, nameError }: { form: PersonForm; onChange: (patch: Partial<PersonForm>) => void; nameError?: string }) {
  const { t } = useI18n()
  return (
    <div className="grid grid-cols-2 gap-3">
      <Field label={t('plan.person.name')} error={nameError}>
        <Input value={form.name} onChange={(e) => onChange({ name: e.target.value })} placeholder="Ana Lopez" />
      </Field>
      <Field label={t('plan.person.emails')} hint={t('plan.person.emailsHint')}>
        <Input value={form.emails} onChange={(e) => onChange({ emails: e.target.value })} placeholder="ana@example.com" spellCheck={false} />
      </Field>
      <Field label={t('plan.person.github')}>
        <Input value={form.github} onChange={(e) => onChange({ github: e.target.value })} placeholder="ana-dev" spellCheck={false} />
      </Field>
      <Field label={t('plan.person.jira')} hint={t('plan.person.trackerHint')}>
        <Input value={form.jira} onChange={(e) => onChange({ jira: e.target.value })} placeholder="Ana Lopez" spellCheck={false} />
      </Field>
      <Field label={t('plan.person.linear')}>
        <Input value={form.linear} onChange={(e) => onChange({ linear: e.target.value })} spellCheck={false} />
      </Field>
      <Field label={t('plan.person.slack')}>
        <Input value={form.slack} onChange={(e) => onChange({ slack: e.target.value })} placeholder="@ana" spellCheck={false} />
      </Field>
      <Field label={t('plan.person.notes')} hint={t('plan.person.notesHint')} className="col-span-2">
        <Textarea rows={3} value={form.notes} onChange={(e) => onChange({ notes: e.target.value })} />
      </Field>
    </div>
  )
}
