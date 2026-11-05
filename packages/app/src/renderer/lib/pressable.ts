import type { KeyboardEvent } from 'react'

/**
 * Props that make a non-button element (a table row, a list item, an SVG group) act as a button:
 * focusable, announced as a button, and pressed with a click, Enter or Space. Spread them on the
 * element: `<tr {...pressable(() => pick(row))}>`.
 */
export function pressable(onPress: () => void, options: { label?: string; pressed?: boolean } = {}) {
  return {
    role: 'button' as const,
    tabIndex: 0,
    'aria-label': options.label,
    'aria-pressed': options.pressed,
    onClick: () => onPress(),
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key !== 'Enter' && e.key !== ' ') return
      e.preventDefault()
      e.stopPropagation()
      onPress()
    }
  }
}
