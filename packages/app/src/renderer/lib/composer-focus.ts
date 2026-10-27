/** What the composer knows when deciding whether to take the keyboard focus. */
export interface ComposerFocusState {
  /** The session's chat is the one on screen. */
  active: boolean
  /** The composer takes input. */
  enabled: boolean
}

/**
 * Whether the composer should take the focus, as Workhub 1's console does when its session is
 * picked: when its chat comes on screen (a sidebar click, opening a session from anywhere, the
 * App view picked), or when it starts taking input while on screen and the user is not typing
 * somewhere else.
 */
export function shouldFocusComposer(prev: ComposerFocusState, next: ComposerFocusState, typingElsewhere: boolean): boolean {
  if (!next.active || !next.enabled) return false
  if (!prev.active) return true
  return !prev.enabled && !typingElsewhere
}

/** Whether an element takes typing (an input, a textarea, a select, or editable content). */
export function isEditable(el: Element | null): boolean {
  if (!el) return false
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return (el as HTMLElement).isContentEditable === true
}
