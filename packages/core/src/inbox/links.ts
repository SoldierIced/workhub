/**
 * Links of a Plan inbox item or milestone: a short list of labelled web addresses (a dashboard, a
 * doc, a pull request). Shared by both, checked the same way wherever they come in.
 */

export interface PlanLink {
  /** What the link is, trimmed; the address when nothing was given. */
  label: string
  /** An http(s) address. */
  url: string
}

export const PLAN_LINK_LIMITS = { items: 20, label: 200, url: 2000 } as const

/**
 * Who last changed an inbox item or a milestone: the user in Workhub, an agent through the control
 * endpoint, or the tracker (a linked ticket was done, so the item was marked done).
 */
export type PlanEditor = 'user' | 'agent' | 'tracker'

const isWebUrl = (url: string) => /^https?:\/\/\S+$/i.test(url) && url.length <= PLAN_LINK_LIMITS.url

/**
 * A list of links from untrusted input; a string says what is wrong. Each entry is `{ label?, url }`
 * or a bare address. Repeated addresses are kept once; an empty label becomes the address.
 */
export function parsePlanLinks(value: unknown): PlanLink[] | string {
  if (!Array.isArray(value)) return '"links" must be a list of { "label", "url" }'
  if (value.length > PLAN_LINK_LIMITS.items) return `"links" may have at most ${PLAN_LINK_LIMITS.items} entries`
  const out: PlanLink[] = []
  for (const entry of value) {
    const raw = typeof entry === 'string' ? { url: entry } : entry
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'every link must be { "label", "url" }'
    const r = raw as Record<string, unknown>
    if (typeof r['url'] !== 'string' || !isWebUrl(r['url'].trim())) return `every link needs an http(s) "url" of at most ${PLAN_LINK_LIMITS.url} characters`
    if (r['label'] !== undefined && typeof r['label'] !== 'string') return 'a link "label" must be a string'
    const url = r['url'].trim()
    const label = typeof r['label'] === 'string' ? r['label'].replace(/\s+/g, ' ').trim() : ''
    if (label.length > PLAN_LINK_LIMITS.label) return `a link "label" is longer than ${PLAN_LINK_LIMITS.label} characters`
    if (out.some((l) => l.url === url)) continue
    out.push({ label: label || url, url })
  }
  return out
}

/** Whether a stored list of links is well formed (what `parsePlanLinks` would keep as it is). */
export function planLinksOk(links: unknown): boolean {
  const parsed = parsePlanLinks(links)
  return typeof parsed !== 'string' && JSON.stringify(parsed) === JSON.stringify(links)
}
