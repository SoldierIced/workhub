import { Plus, Sparkles, Trash2, UserRound } from 'lucide-react'
import { useEffect, useState } from 'react'
import { meetingsWith, openItemsOf, plannerSettings, type Person } from '@workhub/core'
import { Button, Spinner } from '../../components/atoms'
import { Card, CardBody, CardHeader, ConfirmDeleteDialog, EmptyState, useToast } from '../../components/molecules'
import { refreshConfig } from '../../configStore'
import { useI18n } from '../../i18n/I18nProvider'
import { cn } from '../../lib/cn'
import { formToPerson, personId, personToForm, type PersonForm } from '../../lib/plan'
import { isDirty } from '../../lib/unsavedChanges'
import { usePlanner } from '../../plannerStore'
import { EventRow } from './EventRow'
import { InboxRow } from './InboxTab'
import { PersonFields } from './PersonFields'
import type { PlanTabContext } from './planTabs'

const blank = (id: string): PersonForm => personToForm({ id, name: '', emails: [] })

/** People: who the user meets, their meetings coming up, and "Prepare 1:1". Edits save to the profile. */
export function PeopleTab({ profile, view, now, busy, brief, oneOnOne, openLink }: PlanTabContext) {
  const { t, formatDate } = useI18n()
  const toast = useToast()
  const people = plannerSettings(profile).people
  const [selected, setSelected] = useState<string | null>(people[0]?.id ?? null)
  const current = people.find((p) => p.id === selected)
  const [form, setForm] = useState<PersonForm>(() => (current ? personToForm(current) : blank('')))
  const [baseline, setBaseline] = useState(form)
  const [nameError, setNameError] = useState(false)
  const [saving, setSaving] = useState(false)
  // The person whose Delete waits for the user's confirmation.
  const [deleting, setDeleting] = useState<Person | null>(null)
  const { view: work } = usePlanner(profile.id, true)

  // The form follows the selection (and what was saved).
  useEffect(() => {
    const next = current ? personToForm(current) : blank(selected === null ? '' : selected)
    setForm(next)
    setBaseline(next)
    setNameError(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, JSON.stringify(current)])

  const savePeople = async (next: Person[]) => {
    setSaving(true)
    try {
      const r = await window.hub.config.saveProfile({ ...profile, planner: { ...plannerSettings(profile), people: next } })
      if (!r.ok) {
        toast(r.issues[0]?.message ?? t('plan.people.saveFailed'), 'danger')
        return false
      }
      await refreshConfig()
      return true
    } finally {
      setSaving(false)
    }
  }
  const save = async () => {
    if (!form.name.trim()) return setNameError(true)
    const person = formToPerson(form)
    const exists = people.some((p) => p.id === person.id)
    if (await savePeople(exists ? people.map((p) => (p.id === person.id ? person : p)) : [...people, person])) {
      toast(t('plan.people.saved'))
      setSelected(person.id)
    }
  }
  const remove = async (id: string) => {
    if (await savePeople(people.filter((p) => p.id !== id))) setSelected(people.find((p) => p.id !== id)?.id ?? null)
  }
  const add = () => setSelected(personId(t('plan.people.newName'), people.map((p) => p.id)))

  const editing = selected !== null
  const upcoming = current ? meetingsWith(current, view.events, now).slice(0, 8) : []
  const openItems = current ? openItemsOf(work?.inbox ?? [], current.id) : []
  return (
    <div className="grid grid-cols-1 gap-4 @min-[760px]:grid-cols-[240px_1fr]">
      <Card className="self-start">
        <CardHeader
          title={t('plan.people.title')}
          actions={
            <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" aria-hidden />} onClick={add}>
              {t('plan.people.add')}
            </Button>
          }
        />
        <CardBody className="flex flex-col gap-0.5">
          {people.length === 0 && <p className="py-2 text-sm text-muted">{t('plan.people.empty')}</p>}
          {people.map((p) => {
            const next = meetingsWith(p, view.events, now)[0]
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => setSelected(p.id)}
                className={cn('flex flex-col items-start rounded-md px-2 py-1.5 text-left hover:bg-surface-hover', p.id === selected && 'bg-accent-soft')}
              >
                <span className="truncate font-medium">{p.name}</span>
                <span className="truncate text-xs text-muted">{next ? t('plan.people.next', { time: formatDate(next.start, { weekday: 'short', hour: '2-digit', minute: '2-digit' }) }) : t('plan.people.noNext')}</span>
              </button>
            )
          })}
        </CardBody>
      </Card>

      {!editing ? (
        <EmptyState icon={<UserRound className="size-6" aria-hidden />} title={t('plan.people.pick')} description={t('plan.people.pickHint')} />
      ) : (
        <div className="flex min-w-0 flex-col gap-4">
          {current && (
            <header className="flex items-center gap-2 px-1">
              <h2 className="min-w-0 flex-1 truncate text-lg font-semibold">{current.name}</h2>
              <Button size="sm" icon={busy === `person:${current.id}` ? <Spinner /> : <Sparkles className="size-3.5" aria-hidden />} disabled={busy === `person:${current.id}`} onClick={() => oneOnOne(current.id)}>
                {t('plan.people.oneOnOne')}
              </Button>
              <Button size="sm" variant="ghost" aria-label={t('plan.people.remove', { name: current.name })} title={t('plan.people.remove', { name: current.name })} icon={<Trash2 className="size-3.5" aria-hidden />} onClick={() => setDeleting(current)} />
            </header>
          )}
          {current && (
            <section className="flex flex-col gap-2">
              <h2 className="px-1 text-md font-semibold">{t('plan.people.upcoming')}</h2>
              {upcoming.length === 0 ? (
                <p className="px-1 text-sm text-muted">{current.emails.length ? t('plan.people.noUpcoming') : t('plan.people.noEmails')}</p>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {upcoming.map((e) => (
                    <EventRow key={e.id} event={e} brief={view.briefs[e.id]} now={now} withDay busy={busy === `event:${e.id}`} onBrief={() => brief(e.id)} onJoin={openLink} />
                  ))}
                </ul>
              )}
            </section>
          )}
          {current && (
            <section className="flex flex-col gap-2" data-testid="person-inbox">
              <h2 className="px-1 text-md font-semibold">{t('planner.people.openItems')}</h2>
              {openItems.length === 0 ? (
                <p className="px-1 text-sm text-muted">{t('planner.people.noOpenItems')}</p>
              ) : (
                <ul className="rounded-lg border border-border bg-surface shadow-sm">
                  {openItems.map((i) => (
                    <InboxRow key={i.id} item={i} people={people} busy={false} canCreate={false} profileId={profile.id} />
                  ))}
                </ul>
              )}
            </section>
          )}
          {/* Editing the person's details comes last: the meetings and open items are what you look for first. */}
          <Card>
            <CardHeader
              title={current ? t('plan.people.editTitle') : t('plan.people.newTitle')}
            />
            <CardBody className="flex flex-col gap-3">
              <PersonFields form={form} onChange={(patch) => setForm((f) => ({ ...f, ...patch, id: current ? f.id : patch.name !== undefined ? personId(patch.name, people.map((p) => p.id)) : f.id }))} nameError={nameError ? t('plan.person.nameRequired') : undefined} />
              <div className="flex justify-end gap-2 border-t border-border pt-3">
                {isDirty(baseline, form) && (
                  <Button variant="ghost" onClick={() => setForm(baseline)}>
                    {t('common.cancel')}
                  </Button>
                )}
                <Button variant="primary" disabled={saving || (!!current && !isDirty(baseline, form))} onClick={() => void save()}>
                  {t('plan.people.save')}
                </Button>
              </div>
            </CardBody>
          </Card>
        </div>
      )}
      <ConfirmDeleteDialog
        name={deleting?.name ?? ''}
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t('plan.people.confirmDelete', { name: deleting?.name ?? '' })}
        description={t('plan.people.confirmDeleteBody')}
        onConfirm={() => {
          if (deleting) void remove(deleting.id)
        }}
      />
    </div>
  )
}
