/** The first guess before the chat measures the message: longer than this many lines or characters starts collapsed. */
export const LONG_MESSAGE_LINES = 30
export const LONG_MESSAGE_CHARS = 3000

/** Whether a message is long enough to show collapsed (a pasted log or crash report). */
export function isLongMessage(text: string): boolean {
  if (text.length > LONG_MESSAGE_CHARS) return true
  let lines = 1
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10 && ++lines > LONG_MESSAGE_LINES) return true
  return false
}
