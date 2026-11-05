/** The highlight a search result (or a "Fix" button) leaves on the row it opened. */
export const ROW_HIGHLIGHT_MS = 2000
const HIGHLIGHT = ['ring-2', 'ring-accent', 'rounded-md', 'bg-accent-soft/40', 'transition-colors']

const normalize = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ').trim()

/**
 * Finds the row of a setting by its label inside the section on screen, scrolls it into view and
 * highlights it for a moment. Labels come from the same i18n keys as the search index, so the label
 * text is what the row shows. Returns false when no element shows that label.
 */
export function focusSettingRow(container: HTMLElement | null, label: string): boolean {
  if (!container || !label) return false
  const wanted = normalize(label)
  const candidates = container.querySelectorAll<HTMLElement>('h2, h3, legend, label, span, p, summary, button, [role="switch"]')
  let match: HTMLElement | null = null
  for (const el of candidates) {
    // The element's own text (a label with a help button still reads as its label).
    const own = normalize([...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join(' '))
    if (own === wanted || normalize(el.textContent) === wanted) {
      match = el
      break
    }
  }
  if (!match) return false
  // A Field or SwitchRow label sits in a span inside the row; other labels sit in a marked row or group.
  const row = match.tagName === 'LABEL' ? (match.parentElement?.parentElement ?? match) : (match.closest<HTMLElement>('[data-settings-row], fieldset, [data-settings-group]') ?? match)
  row.scrollIntoView({ behavior: 'smooth', block: 'center' })
  row.classList.add(...HIGHLIGHT)
  window.setTimeout(() => row.classList.remove(...HIGHLIGHT), ROW_HIGHLIGHT_MS)
  return true
}
