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

export const NOTIFY_BODY: Record<AttentionKind, MessageKey> = {
  replied: 'notify.replied',
  needsAnswer: 'notify.needsAnswer',
  error: 'notify.error'
}
