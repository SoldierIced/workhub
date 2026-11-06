/** The highlight a search result (or a "Fix" button) leaves on the row it opened. */
export const ROW_HIGHLIGHT_MS = 2000
/** How long a group pointed at by `section#anchor` stays highlighted, with the other groups dimmed. */
export const GROUP_HIGHLIGHT_MS = 2800
const HIGHLIGHT = ['ring-2', 'ring-accent', 'rounded-md', 'bg-accent-soft/40', 'transition-colors']
/** The other groups while one is pointed at: faded and blurred (SettingsGroup animates the change). */
const DIMMED = ['opacity-35', 'blur-[1.5px]']

const normalize = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ').trim()

/**
 * Scrolls `target` into view and highlights it for `ms`; `dim` also fades the other groups of
 * `container`. A click anywhere ends it early.
 */
function highlight(container: HTMLElement, target: HTMLElement, ms: number, dim: boolean): void {
  target.scrollIntoView({ behavior: 'smooth', block: 'center' })
  target.classList.add(...HIGHLIGHT)
  const others = dim ? [...container.querySelectorAll<HTMLElement>('[data-settings-group]')].filter((g) => g !== target) : []
  for (const g of others) g.classList.add(...DIMMED)
  let done = false
  const end = () => {
    if (done) return
    done = true
    window.clearTimeout(timer)
    window.removeEventListener('pointerdown', end)
    target.classList.remove(...HIGHLIGHT)
    for (const g of others) g.classList.remove(...DIMMED)
  }
  const timer = window.setTimeout(end, ms)
  if (dim) window.addEventListener('pointerdown', end, { once: true })
}

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
    // A tab or a closed disclosure kept mounted but hidden is not where the row shows.
    if (el.closest('[hidden]')) continue
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
  highlight(container, row, ROW_HIGHLIGHT_MS, false)
  return true
}

/**
 * Points at the group named `anchor` (`<SettingsGroup anchor>`, the `#updates` of `general#updates`):
 * scrolls it into view and highlights it while the other groups dim. Returns false when the
 * section on screen has no such group (yet).
 */
export function focusSettingGroup(container: HTMLElement | null, anchor: string): boolean {
  if (!container || !anchor) return false
  const group = container.querySelector<HTMLElement>(`[data-settings-group="${CSS.escape(anchor)}"]`)
  if (!group) return false
  highlight(container, group, GROUP_HIGHLIGHT_MS, true)
  return true
}
