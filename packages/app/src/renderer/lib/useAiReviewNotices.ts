import { useEffect } from 'react'
import type { AiReviewNotice } from '@shared/ai-review-api'
import { useToast } from '../components/molecules'
import { useI18n } from '../i18n/I18nProvider'
import type { MessageKey } from '../i18n/translate'
import { flagAttention } from '../store'

export const ESCALATION_TEXT: Record<Extract<AiReviewNotice, { kind: 'paused' }>['reason'], MessageKey> = {
  reviewer: 'aiReview.reason.reviewer',
  maxRounds: 'aiReview.reason.maxRounds',
  reopened: 'aiReview.reason.reopened',
  disputed: 'aiReview.reason.disputed',
  unparsed: 'aiReview.reason.unparsed'
}

/** The words of an AI review notice, in the UI language. */
export function aiReviewNoticeText(n: AiReviewNotice, t: (key: MessageKey, params?: Record<string, string | number>) => string): { title: string; body: string } {
  switch (n.kind) {
    case 'paused':
      return { title: t('aiReview.notify.paused', { branch: n.branch }), body: [t(ESCALATION_TEXT[n.reason]), n.detail].filter(Boolean).join(' ') }
    case 'ready':
      return { title: t('aiReview.notify.ready', { branch: n.branch }), body: t('aiReview.notify.readyBody') }
    case 'held':
      return { title: t('aiReview.notify.held'), body: t('aiReview.notify.heldBody', { window: n.budget.window ?? '' }) }
  }
}

/**
 * AI review notices: an OS notification with the reason (a click opens the dev session), a toast,
 * and the session's attention flag, so its row and its group show that it needs the user.
 */
export function useAiReviewNotices(): void {
  const { t } = useI18n()
  const toast = useToast()
  useEffect(
    () =>
      window.hub.aiReview.onNotice((n) => {
        const w = aiReviewNoticeText(n, t)
        toast(`${w.title}: ${w.body}`, n.kind === 'ready' ? undefined : 'danger')
        window.hub.notifications.show({ title: w.title, body: w.body, sessionId: n.devSessionId ?? '', kind: 'aiReview' })
        if (n.devSessionId) flagAttention(n.devSessionId, n.kind === 'ready' ? 'replied' : 'needsAnswer')
      }),
    [t, toast]
  )
}
