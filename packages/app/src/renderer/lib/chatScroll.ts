/**
 * When the chat log follows new output (Workhub 1's console): it sticks to the bottom while the
 * reader is there, and leaves the scroll alone once they scroll up to read, until they send or
 * queue a prompt of their own.
 */

/** How close to the bottom, in pixels, still counts as "at the bottom". */
export const AT_BOTTOM_SLACK_PX = 24

export interface FollowMark {
  /** Id of the last prompt the user sent, when the log last changed. */
  lastPromptId: number | undefined
  /** Prompts queued for after the turn, when the log last changed. */
  queued: number
}

export const isAtBottom = (el: Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>): boolean => el.scrollHeight - el.scrollTop - el.clientHeight < AT_BOTTOM_SLACK_PX

export function lastPromptId(items: readonly { id: number; kind: string }[]): number | undefined {
  for (let i = items.length - 1; i >= 0; i--) if (items[i]!.kind === 'user') return items[i]!.id
  return undefined
}

/** Whether a change of the log scrolls it to the bottom, and the mark for the next change. */
export function followLog(previous: FollowMark, items: readonly { id: number; kind: string }[], queued: number, atBottom: boolean): { follow: boolean; mark: FollowMark } {
  const mark = { lastPromptId: lastPromptId(items), queued }
  const sent = mark.lastPromptId !== previous.lastPromptId || queued > previous.queued
  return { follow: atBottom || sent, mark }
}
