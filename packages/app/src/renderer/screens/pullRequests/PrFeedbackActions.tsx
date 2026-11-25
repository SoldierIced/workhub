import { MessageSquareReply, Wrench } from 'lucide-react'
import { useState } from 'react'
import type { PullRequest, PullRequestDetail } from '@workhub/core'
import type { SessionView } from '@shared/api'
import type { PullRequestTarget } from '@shared/links-api'
import { Button } from '../../components/atoms'
import { useToast } from '../../components/molecules'
import { useI18n, type I18n } from '../../i18n/I18nProvider'
import type { Locale } from '../../i18n/translate'
import { errorText } from '../../lib/errorText'
import { feedbackKinds, feedbackPrompt, targetOf, type PrFeedbackKind } from '../../lib/prFeedback'
import type { PrToolbarAction } from './PrActionsToolbar'

const ICON: Record<PrFeedbackKind, typeof Wrench> = { fixCi: Wrench, addressReview: MessageSquareReply }

/**
 * The pull request window's "Fix CI" and "Address review comments": each sends its prompt to the
 * session linked to the PR (the main window finds it, or offers to start one). They fold into
 * "More" last of all.
 */
export function prFeedbackToolbarActions(detail: PullRequestDetail | undefined, target: PullRequestTarget, profileId: string | null, t: I18n['t'], locale: Locale): PrToolbarAction[] {
  if (!detail) return []
  return feedbackKinds(detail).map((kind) => {
    const Icon = ICON[kind]
    return {
      key: kind,
      side: 'start',
      fold: 5,
      variant: 'secondary',
      icon: <Icon className="size-3.5" aria-hidden />,
      label: t(`prFeedback.${kind}`),
      title: t(`prFeedback.${kind}Hint`),
      onSelect: () => window.hub.links.request({ kind: 'pullRequestPrompt', profileId, pr: target, prompt: feedbackPrompt(locale, kind, target, detail) })
    }
  })
}

/**
 * The same two actions on a pull request row of a session's monitor: the session is the one the PR
 * belongs to, so the prompt goes to it. A list row has no comments or check names: the PR is read first.
 */
export function MonitorPrFeedback({ pr, profileId, session }: { pr: PullRequest; profileId: string | null; session: Pick<SessionView, 'id' | 'state'> }) {
  const { t, locale } = useI18n()
  const notify = useToast()
  const [busy, setBusy] = useState(false)
  const kinds = session.state === 'stopped' || session.state === 'error' ? [] : feedbackKinds(pr)
  if (!kinds.length) return null
  const send = async (kind: PrFeedbackKind) => {
    setBusy(true)
    try {
      const r = await window.hub.codeHost.detail(profileId, pr.url, true)
      if (!r.ok) return notify(t('prFeedback.loadFailed', { message: r.error }), 'danger')
      const target = targetOf(r.detail)
      // Loaded on use: the prompt queue pulls in the preload bridge's constants, which the monitor's tests do not have.
      const { submitPrompt } = await import('../../promptQueue')
      const sent = submitPrompt(session.id, session.state, false, feedbackPrompt(locale, kind, target, r.detail)) !== 'refused'
      notify(sent ? t('prFeedback.sentHere') : t('prFeedback.notSent'), sent ? 'success' : 'danger')
    } catch (e) {
      notify(t('prFeedback.loadFailed', { message: errorText(e) }), 'danger')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {kinds.map((kind) => {
        const Icon = ICON[kind]
        return (
          <Button key={kind} size="sm" variant="secondary" disabled={busy} title={t('prFeedback.monitorHint')} icon={<Icon className="size-3.5" aria-hidden />} onClick={() => void send(kind)}>
            {t(`prFeedback.${kind}`)}
          </Button>
        )
      })}
    </div>
  )
}
