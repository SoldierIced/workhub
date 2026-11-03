import type { AttentionKind, StatusLevel } from '@workhub/core'
import type { Tone } from '../components/atoms/Badge'
import type { MessageKey } from '../i18n/translate'

/** Terminal title sequences (`ESC ] ... BEL`) end with a bell character that is not a bell. */
const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g

/** Whether terminal output rings the bell: the signal a terminal agent gives when it wants a look. */
export function containsBell(output: string): boolean {
  return output.replace(OSC, '').includes('\u0007')
}

export const LEVEL_TONE: Record<StatusLevel, Tone> = {
  error: 'danger',
  needsAnswer: 'warning',
  readyToReview: 'success',
  working: 'info'
}

export const LEVEL_LABEL: Record<StatusLevel, MessageKey> = {
  error: 'attention.error',
  needsAnswer: 'attention.needsAnswer',
  readyToReview: 'attention.readyToReview',
  working: 'attention.working'
}

/** Which Settings switch (an `AppOptions` key) turns the notification of each kind off. */
export const NOTIFY_OPTION = { replied: 'notifyReplied', needsAnswer: 'notifyNeedsAnswer', error: 'notifyError' } as const satisfies Record<AttentionKind, string>

/** How much of the agent's words a notification shows. */
export const NOTIFY_SNIPPET = 160

/** A Markdown text as one short line: no code blocks, marks or link addresses, cut at `max` characters. */
export function snippet(text: string, max = NOTIFY_SNIPPET): string {
  const line = text
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`>#]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}

/**
 * What a session's notification says besides its kind: the start of the agent's last reply, the
 * question it waits on, or the error. Empty when there is nothing to quote.
 */
export function attentionDetail(
  items: readonly { kind: string; text?: string; title?: string; answer?: string; questions?: readonly { question: string }[] }[],
  kind: AttentionKind
): string {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!
    if (kind === 'replied' && item.kind === 'agent' && item.text?.trim()) return snippet(item.text)
    if (kind === 'needsAnswer' && item.kind === 'permission' && item.answer === undefined) {
      const text = item.questions?.[0]?.question ?? item.title
      if (text) return snippet(text)
    }
    if (kind === 'error' && item.kind === 'error' && item.text?.trim()) return snippet(item.text)
  }
  return ''
}

export const NOTIFY_BODY: Record<AttentionKind, MessageKey> = {
  replied: 'notify.replied',
  needsAnswer: 'notify.needsAnswer',
  error: 'notify.error'
}
