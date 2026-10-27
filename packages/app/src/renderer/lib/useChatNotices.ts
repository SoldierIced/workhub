import { useEffect } from 'react'
import { plainText } from '@workhub/core'
import type { ChatNoticeEvent } from '@shared/chat-api'
import { useToast } from '../components/molecules'
import { useI18n } from '../i18n/I18nProvider'
import type { MessageKey } from '../i18n/translate'
import { pushUser } from '../store'

const NOT_WOKEN: Record<string, MessageKey> = {
  automationOff: 'slack.notice.notWoken.automationOff',
  noReplies: 'slack.notice.notWoken.noReplies',
  openElsewhere: 'slack.notice.notWoken.openElsewhere',
  budget: 'slack.notice.notWoken.budget'
}

/**
 * The Slack watcher's and the automations' notices, worded in the UI language: a toast, and an OS
 * notification (a click opens the Slack screen, or Automations for an automation's failure). Prompts typed by an automation show in the chat.
 */
export function useChatNotices(): void {
  const { t, tn } = useI18n()
  const toast = useToast()
  useEffect(() => {
    const word = (n: ChatNoticeEvent): { title: string; body: string; danger?: boolean } | null => {
      switch (n.kind) {
        case 'myPullRequest':
          return { title: t('slack.notice.myPullRequest', { user: n.user }), body: plainText(n.text) }
        case 'replies':
          return { title: tn('slack.notice.replies', n.replies.length + n.more, { title: n.title }), body: n.replies.map((r) => `${r.user}: ${plainText(r.text)}`).join('\n') }
        case 'tracking':
          return { title: t('slack.notice.tracking', { title: n.title }), body: '' }
        case 'watchFailed':
          return { title: t('slack.notice.watchFailed'), body: n.error, danger: true }
        case 'notWoken':
          return { title: t('slack.notice.notWoken', { title: n.title }), body: NOT_WOKEN[n.reason] ? t(NOT_WOKEN[n.reason]!) : n.reason }
        case 'automationFailed':
          return { title: t('slack.notice.automationFailed', { name: n.automationName }), body: n.detail, danger: true }
        default:
          return null
      }
    }
    const offNotice = window.hub.slack.onNotice((n) => {
      const w = word(n)
      if (!w) return
      toast(w.body ? `${w.title}: ${w.body}` : w.title, w.danger ? 'danger' : undefined)
      // Automation failures open Automations and follow their own switch; the rest are Slack's.
      const automation = n.kind === 'automationFailed'
      if (n.kind !== 'tracking') window.hub.notifications.show({ title: w.title, body: w.body, sessionId: '', kind: automation ? 'automations' : 'slack', route: automation ? 'automations' : 'slack' })
    })
    const offPrompted = window.hub.automations.onPrompted((id, text) => pushUser(id, text))
    return () => {
      offNotice()
      offPrompted()
    }
  }, [t, tn, toast])
}
