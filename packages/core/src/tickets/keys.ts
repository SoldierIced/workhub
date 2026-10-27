/**
 * Ticket-key recognition, one pattern per tracker:
 * - Jira and Linear: `PROJ-123` (a project key of letters/digits, a dash, a number).
 * - GitHub Issues: `#123` inside one repository, `owner/repo#123` or an issue URL anywhere.
 *
 * Keys are returned in a canonical form (`PROJ-123` upper case, `owner/repo#123`) so the same
 * ticket always has one key, whatever the casing of the branch or title it was found in.
 */

export const TICKET_KEY_PROVIDERS = ['jira', 'linear', 'github-issues'] as const
export type TicketKeyProviderId = (typeof TICKET_KEY_PROVIDERS)[number]

/** One tracker to look for. */
export interface TicketKeyProvider {
  provider: TicketKeyProviderId | (string & {})
  /**
   * Jira/Linear: the project keys of the profile (`ABC` for `ABC-123`). With them, matching is
   * case-insensitive (branches are lower case) and exact; without them, any upper-case
   * key-like text matches except well-known non-tickets such as `UTF-8`.
   */
  projectKeys?: readonly string[]
  /** GitHub Issues: `owner/repo`, which a bare `#123` belongs to. */
  repo?: string
}

export interface TicketKeyMatch {
  key: string
  provider: string
  /** Offset of the first occurrence in the text. */
  index: number
}

/** Upper-case key-like text that is not a ticket. Only applied when no project keys are known. */
const NOT_PROJECTS = new Set(['UTF', 'ISO', 'SHA', 'MD', 'HTTP', 'TLS', 'SSL', 'RFC', 'CVE', 'AES', 'RSA', 'IPV', 'ES', 'PEP', 'WCAG', 'EN', 'X', 'Y'])

const PROJECT_KEY = /^[A-Za-z][A-Za-z0-9]{0,9}$/
const GENERIC_KEY = /(?<![A-Za-z0-9])([A-Z][A-Z0-9]{1,9})-(\d{1,7})(?![A-Za-z0-9])/g
const ISSUE_URL = /github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/(\d+)(?![A-Za-z0-9])/gi
const REPO_REF = /(?<![A-Za-z0-9_.\/-])([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)(?![A-Za-z0-9])/g
const BARE_REF = /(?<![A-Za-z0-9_.\/&#-])#(\d{1,7})(?![A-Za-z0-9])/g

/** Regex source for a given set of project keys, matched case-insensitively. */
function keyedPattern(projectKeys: readonly string[]): RegExp | null {
  const valid = projectKeys.map((k) => k.trim()).filter((k) => PROJECT_KEY.test(k))
  if (valid.length === 0) return null
  return new RegExp(`(?<![A-Za-z0-9])(${valid.join('|')})-(\\d{1,7})(?![A-Za-z0-9])`, 'gi')
}

function projectMatches(text: string, provider: TicketKeyProvider): TicketKeyMatch[] {
  const keys = provider.projectKeys?.filter((k) => k.trim()) ?? []
  const out: TicketKeyMatch[] = []
  if (keys.length > 0) {
    const pattern = keyedPattern(keys)
    if (!pattern) return out
    for (const m of text.matchAll(pattern)) out.push({ key: `${m[1]!.toUpperCase()}-${m[2]}`, provider: provider.provider, index: m.index })
    return out
  }
  for (const m of text.matchAll(GENERIC_KEY)) {
    if (NOT_PROJECTS.has(m[1]!)) continue
    out.push({ key: `${m[1]}-${m[2]}`, provider: provider.provider, index: m.index })
  }
  return out
}

function issueMatches(text: string, provider: TicketKeyProvider): TicketKeyMatch[] {
  const repo = provider.repo?.trim().toLowerCase()
  const out: TicketKeyMatch[] = []
  const add = (owner: string, name: string, n: string, index: number) => {
    const full = `${owner}/${name}`.toLowerCase()
    if (repo && full !== repo) return
    out.push({ key: `${full}#${n}`, provider: provider.provider, index })
  }
  for (const m of text.matchAll(ISSUE_URL)) add(m[1]!, m[2]!, m[3]!, m.index)
  for (const m of text.matchAll(REPO_REF)) add(m[1]!, m[2]!, m[3]!, m.index)
  if (repo) for (const m of text.matchAll(BARE_REF)) out.push({ key: `${repo}#${m[1]}`, provider: provider.provider, index: m.index })
  return out
}

/**
 * Every ticket key in the text for the given trackers, in order of first appearance, without
 * repeats. A key claimed by an earlier provider is not reported again for a later one (Jira and
 * Linear share the `PROJ-123` shape; a profile has one tracker, so this only matters for lists).
 */
export function findTicketKeys(text: string, providers: readonly TicketKeyProvider[]): TicketKeyMatch[] {
  if (!text) return []
  const seen = new Set<string>()
  const found: TicketKeyMatch[] = []
  for (const provider of providers) {
    const matches = provider.provider === 'github-issues' ? issueMatches(text, provider) : projectMatches(text, provider)
    for (const m of matches) {
      if (seen.has(m.key)) continue
      seen.add(m.key)
      found.push(m)
    }
  }
  return found.sort((a, b) => a.index - b.index)
}

/** Just the keys of `findTicketKeys`. */
export function ticketKeysIn(text: string, providers: readonly TicketKeyProvider[]): string[] {
  return findTicketKeys(text, providers).map((m) => m.key)
}

/** Whether the whole string is one ticket key of the provider. */
export function isTicketKey(text: string, provider: TicketKeyProvider): boolean {
  const t = text.trim()
  if (findTicketKeys(t, [provider]).length !== 1) return false
  if (provider.provider === 'github-issues') return /^(?:[^\s#/]+\/[^\s#/]+)?#\d+$|^https?:\/\/github\.com\/\S+\/issues\/\d+\/?$/i.test(t)
  return /^[A-Za-z][A-Za-z0-9]{0,9}-\d{1,7}$/.test(t)
}

/** The project part of a Jira/Linear key (`ABC` for `ABC-123`); null for other keys. */
export function projectOfKey(key: string): string | null {
  const m = /^([A-Z][A-Z0-9]*)-\d+$/.exec(key)
  return m ? m[1]! : null
}
