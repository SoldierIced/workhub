import { ExternalLink, Pencil } from 'lucide-react'
import { useState } from 'react'
import type { InboxAction, InboxItem, InboxKind } from '@workhub/core'
import { Badge, Spinner } from '../../renderer/components/atoms'
import { Markdown } from '../../renderer/components/molecules/Markdown'
import { useI18n } from '../../renderer/i18n/I18nProvider'
import { INBOX_KIND_LABEL, INBOX_SOURCE_LABEL, INBOX_STATUS_LABEL, inboxActionLabel } from '../../renderer/lib/planner'
import { goBack, useConfig, useProfileId } from '../app-context'
import { openLink, usePlanner } from '../plan-data'
import { BigButton, Body, Empty, Header, InlineConfirm, Row, Screen, SectionTitle } from '../ui'
import { itemActions, useItemActions } from './PlanScreen'

const INPUT = 'h-11 w-full rounded-xl border border-border-strong bg-surface px-3 text-md text-text'

/** One inbox item: what it is, where it came from, its facts and links; the actions of its state; editing its title, detail, kind and due date. */
export function PlanItemScreen({ id }: { id: string }) {
  const { t } = useI18n()
  const { config } = useConfig()
  const [profileId] = useProfileId(config)
  const planner = usePlanner(profileId)
  const view = planner.data
  const item = view?.inbox.find((i) => i.id === id)
  const [editing, setEditing] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  const { busy, error, act } = useItemActions(profileId ?? '', planner.reload)

  if (!view) {
    return (
      <Screen>
        <Header title={t('web.plan.item')} back={{ screen: 'plan', tab: 'tasks' }} />
        <Body>{planner.loading ? <Spinner className="mx-auto mt-16 size-6" /> : <p className="px-4 pt-4 text-sm text-danger">{planner.error}</p>}</Body>
      </Screen>
    )
  }
  if (!item || !profileId) {
    return (
      <Screen>
        <Header title={t('web.plan.item')} back={{ screen: 'plan', tab: 'tasks' }} />
        <Body>
          <Empty title={t('planner.detail.missing')} hint={t('planner.detail.missingHint')} />
        </Body>
      </Screen>
    )
  }
  if (editing) return <ItemEditor profileId={profileId} item={item} onDone={() => (setEditing(false), planner.reload())} />

  const actions = itemActions(item, view.tracker.create)
  const ticket = view.itemTickets[item.id]
  const run = (action: InboxAction) => (action === 'discard' ? setDiscarding(true) : void act(item, action))
  return (
    <Screen>
      <Header
        title={t(INBOX_KIND_LABEL[item.kind])}
        back={{ screen: 'plan', tab: item.status === 'pending' ? 'inbox' : 'tasks' }}
        right={
          <button type="button" aria-label={t('planner.detail.edit')} onClick={() => setEditing(true)} className="flex size-10 items-center justify-center rounded-lg text-muted active:bg-surface-hover">
            <Pencil className="size-5" aria-hidden />
          </button>
        }
      />
      <Body>
        <div className="flex flex-col gap-3 px-4 pt-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={item.status === 'pending' ? 'warning' : item.status === 'done' ? 'success' : item.status === 'discarded' ? 'neutral' : 'info'}>{t(INBOX_STATUS_LABEL[item.status])}</Badge>
            <span className="text-xs text-muted">{item.source.label ?? t(INBOX_SOURCE_LABEL[item.source.type])}</span>
          </div>
          <h1 className="text-xl font-semibold leading-snug">{item.title}</h1>
          {item.detail ? <Markdown text={item.detail} className="text-md" /> : <p className="text-sm text-subtle">{t('planner.detail.noBody')}</p>}
        </div>

        <SectionTitle>{t('web.plan.facts')}</SectionTitle>
        <div className="mx-4 rounded-xl border border-border bg-surface">
          <Fact label={t('planner.inbox.dueLabel')} value={item.due} />
          <Fact label={t('planner.inbox.criticality')} value={item.criticality} />
          <Fact label={t('planner.inbox.area')} value={item.area} />
          {item.ticket && (
            <Row className="border-t border-border first:border-t-0" onClick={item.ticket.url ? () => openLink(item.ticket!.url!) : undefined} right={item.ticket.url ? <ExternalLink className="size-4 text-subtle" aria-hidden /> : undefined}>
              <div className="text-xs text-muted">{t('planner.detail.ticket')}</div>
              <div className="font-mono text-sm">
                {item.ticket.key}
                {ticket?.status ? ` · ${ticket.status}` : ''}
              </div>
            </Row>
          )}
          {[...(item.link ? [{ label: item.link, url: item.link }] : []), ...(item.links ?? [])].map((l) => (
            <Row key={l.url} className="border-t border-border first:border-t-0" onClick={() => openLink(l.url)} right={<ExternalLink className="size-4 text-subtle" aria-hidden />}>
              <div className="truncate text-sm text-accent">{l.label || l.url}</div>
            </Row>
          ))}
        </div>

        {error && <p className="px-4 pt-3 text-sm text-danger">{error}</p>}
        {actions.length > 0 && (
          <div className="flex flex-col gap-2 px-4 pt-6 pb-6">
            {discarding ? (
              <InlineConfirm question={t('planner.inbox.confirmDiscard', { title: item.title })} yes={t('planner.inbox.action.discard')} danger onNo={() => setDiscarding(false)} onYes={() => (setDiscarding(false), void act(item, 'discard'))} />
            ) : (
              actions.map((action, i) => (
                <BigButton key={action} variant={i === 0 && action !== 'discard' ? 'primary' : action === 'discard' ? 'danger' : 'secondary'} disabled={busy === item.id} onClick={() => run(action)}>
                  {busy === item.id ? <Spinner className="size-4" /> : null}
                  {t(inboxActionLabel(action, item.kind))}
                </BigButton>
              ))
            )}
          </div>
        )}
      </Body>
    </Screen>
  )
}

function Fact({ label, value }: { label: string; value: string | undefined }) {
  if (!value) return null
  return (
    <Row className="border-t border-border first:border-t-0">
      <div className="text-xs text-muted">{label}</div>
      <div className="text-sm">{value}</div>
    </Row>
  )
}

function ItemEditor({ profileId, item, onDone }: { profileId: string; item: InboxItem; onDone: () => void }) {
  const { t } = useI18n()
  const [title, setTitle] = useState(item.title)
  const [detail, setDetail] = useState(item.detail)
  const [kind, setKind] = useState<InboxKind>(item.kind)
  const [due, setDue] = useState(item.due ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    if (!title.trim()) return setError(t('planner.inbox.titleRequired'))
    setSaving(true)
    setError(null)
    try {
      const r = await window.hub.planner.editItem(profileId, item.id, { title: title.trim(), detail, kind, due: due || null })
      if (!r.ok) setError(r.error)
      else onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }
  return (
    <Screen>
      <Header title={t('planner.detail.edit')} />
      <Body>
        <ItemFields title={title} detail={detail} kind={kind} due={due} onTitle={setTitle} onDetail={setDetail} onKind={setKind} onDue={setDue} />
        {error && <p className="px-4 pt-3 text-sm text-danger">{error}</p>}
        <div className="flex flex-col gap-2 px-4 pt-6 pb-6">
          <BigButton disabled={saving} onClick={() => void save()}>
            {saving ? <Spinner className="size-4" /> : null}
            {t('planner.detail.save')}
          </BigButton>
          <BigButton variant="secondary" onClick={onDone}>
            {t('web.cancel')}
          </BigButton>
        </div>
      </Body>
    </Screen>
  )
}

/** The fields of an item, shared by the editor and the "new item" screen. */
export function ItemFields({ title, detail, kind, due, onTitle, onDetail, onKind, onDue }: { title: string; detail: string; kind: InboxKind; due: string; onTitle: (v: string) => void; onDetail: (v: string) => void; onKind: (v: InboxKind) => void; onDue: (v: string) => void }) {
  const { t } = useI18n()
  return (
    <div className="flex flex-col gap-4 px-4 pt-4">
      <div role="radiogroup" aria-label={t('planner.inbox.kind')} className="flex gap-1 rounded-xl bg-surface-hover p-1">
        {(['task', 'bug', 'decision'] as const).map((k) => (
          <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => onKind(k)} className={kind === k ? 'h-9 flex-1 rounded-lg bg-surface text-sm font-medium shadow-sm' : 'h-9 flex-1 rounded-lg text-sm text-muted'}>
            {t(INBOX_KIND_LABEL[k])}
          </button>
        ))}
      </div>
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium text-muted">{t('planner.inbox.title')}</span>
        <input value={title} onChange={(e) => onTitle(e.target.value)} maxLength={300} className={INPUT} />
      </label>
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium text-muted">{t('planner.inbox.detail')}</span>
        <textarea value={detail} onChange={(e) => onDetail(e.target.value)} rows={6} className="w-full rounded-xl border border-border-strong bg-surface px-3 py-2 text-md text-text" />
      </label>
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium text-muted">{t('planner.inbox.dueLabel')}</span>
        <input type="date" value={due} onChange={(e) => onDue(e.target.value)} className={INPUT} />
      </label>
    </div>
  )
}

/** Adds a pending item by hand; a duplicate title asks before adding anyway. */
export function NewItemScreen() {
  const { t } = useI18n()
  const { config } = useConfig()
  const [profileId] = useProfileId(config)
  const [title, setTitle] = useState('')
  const [detail, setDetail] = useState('')
  const [kind, setKind] = useState<InboxKind>('task')
  const [due, setDue] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [duplicate, setDuplicate] = useState(false)
  const save = async (force = false) => {
    if (!profileId) return
    if (!title.trim()) return setError(t('planner.inbox.titleRequired'))
    setSaving(true)
    setError(null)
    try {
      const r = await window.hub.planner.addItem(profileId, { kind, title: title.trim(), detail, due: due || undefined }, force)
      if (r.ok) goBack({ screen: 'plan', tab: 'inbox' })
      else if (r.duplicateOf) setDuplicate(true)
      else setError(r.error)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }
  return (
    <Screen>
      <Header title={t('planner.inbox.addTitle')} back />
      <Body>
        <ItemFields title={title} detail={detail} kind={kind} due={due} onTitle={setTitle} onDetail={setDetail} onKind={setKind} onDue={setDue} />
        {error && <p className="px-4 pt-3 text-sm text-danger">{error}</p>}
        <div className="flex flex-col gap-2 px-4 pt-6 pb-6">
          {duplicate ? (
            <InlineConfirm question={t('planner.inbox.duplicate')} yes={t('planner.inbox.addAnyway')} onNo={() => setDuplicate(false)} onYes={() => (setDuplicate(false), void save(true))} />
          ) : (
            <BigButton disabled={saving || !title.trim()} onClick={() => void save()}>
              {saving ? <Spinner className="size-4" /> : null}
              {t('planner.inbox.addSave')}
            </BigButton>
          )}
        </div>
      </Body>
    </Screen>
  )
}
