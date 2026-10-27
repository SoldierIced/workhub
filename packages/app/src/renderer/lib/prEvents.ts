import { PR_EVENT_KINDS, type PrEvent, type PrEventKind, type PrEventToggles } from '@workhub/core'
import type { I18n } from '../i18n/I18nProvider'
import type { MessageKey, PluralKey } from '../i18n/translate'

export const PR_KIND_LABEL: Record<PrEventKind, MessageKey> = {
  reviewRequested: 'prevent.kind.reviewRequested',
  approved: 'prevent.kind.approved',
  changesRequested: 'prevent.kind.changesRequested',
  newComments: 'prevent.kind.newComments',
  ciFailed: 'prevent.kind.ciFailed',
  ciPassed: 'prevent.kind.ciPassed',
  conflicts: 'prevent.kind.conflicts',
  newCommits: 'prevent.kind.newCommits',
  merged: 'prevent.kind.merged',
  closed: 'prevent.kind.closed'
}

export const PR_KIND_HINT: Record<PrEventKind, MessageKey> = {
  reviewRequested: 'prevent.hint.reviewRequested',
  approved: 'prevent.hint.approved',
  changesRequested: 'prevent.hint.changesRequested',
  newComments: 'prevent.hint.newComments',
  ciFailed: 'prevent.hint.ciFailed',
  ciPassed: 'prevent.hint.ciPassed',
  conflicts: 'prevent.hint.conflicts',
  newCommits: 'prevent.hint.newCommits',
  merged: 'prevent.hint.merged',
  closed: 'prevent.hint.closed'
}

const TITLE_KEY: Record<Exclude<PrEventKind, 'newComments'>, MessageKey> = {
  reviewRequested: 'prevent.title.reviewRequested',
  approved: 'prevent.title.approved',
  changesRequested: 'prevent.title.changesRequested',
  ciFailed: 'prevent.title.ciFailed',
  ciPassed: 'prevent.title.ciPassed',
  conflicts: 'prevent.title.conflicts',
  newCommits: 'prevent.title.newCommits',
  merged: 'prevent.title.merged',
  closed: 'prevent.title.closed'
}

/** The notification text of an event, in the interface language. */
export function prNotificationText(event: PrEvent, i18n: Pick<I18n, 't' | 'tn'>): { title: string; body: string } {
  const { t, tn } = i18n
  const title = event.kind === 'newComments' ? tn('prevent.title.newComments' satisfies PluralKey, event.count ?? 1, { name: event.name }) : t(TITLE_KEY[event.kind], { name: event.name })
  const body = event.actor ? t('prevent.body.byActor', { actor: event.actor, title: event.title }) : event.title
  return { title, body }
}

/** Whether Settings lets an event notify. A kind this build does not know stays quiet. */
export function isNotifiable(event: PrEvent, toggles: PrEventToggles): boolean {
  return PR_EVENT_KINDS.includes(event.kind) && toggles[event.kind] === true
}
