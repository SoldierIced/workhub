import { canonicalUrl, findPullRequestRefs, githubRecognizer, gitlabRecognizer } from '../codehost/urls'
import { ticketKeysIn, type TicketKeyProvider } from '../tickets/keys'

/** Slack timestamps are strings like `1712345678.123456` (seconds with microseconds). */
export function tsValue(ts: string | undefined): number {
  const n = Number(ts)
  return Number.isFinite(n) ? n : 0
}

/** Epoch milliseconds of a chat timestamp. */
export function tsToMs(ts: string | undefined): number {
  return Math.round(tsValue(ts) * 1000)
}

/** A chat timestamp for an epoch-milliseconds time. */
export function msToTs(ms: number): string {
  return (ms / 1000).toFixed(6)
}

export function isAfter(ts: string, other: string | undefined): boolean {
  return tsValue(ts) > tsValue(other)
}

export interface Permalink {
  host: string
  channelId: string
  /** The linked message. */
  ts: string
  /** The thread it belongs to (`thread_ts`), or the message itself. */
  rootTs: string
}

const PERMALINK = /https?:\/\/([\w.-]+\.slack\.com)\/archives\/([A-Z0-9]+)\/p(\d{16})(\?[^\s>|]*)?/

/** `https://<ws>.slack.com/archives/<CHANNEL>/p<16 digits>` with an optional `?thread_ts=`. */
export function parsePermalink(text: string): Permalink | null {
  const m = PERMALINK.exec(text)
  if (!m) return null
  const digits = m[3]!
  const ts = `${digits.slice(0, 10)}.${digits.slice(10)}`
  let rootTs = ts
  if (m[4]) {
    // No URLSearchParams: core has no DOM or Node types.
    const thread = /[?&]thread_ts=(\d{9,11}\.\d{6})(?:&|$)/.exec(m[4])?.[1]
    if (thread) rootTs = thread
  }
  return { host: m[1]!, channelId: m[2]!, ts, rootTs }
}

/** A message permalink on a known workspace host. */
export function buildPermalink(host: string, channelId: string, ts: string, threadTs?: string): string {
  let url = `https://${host}/archives/${channelId}/p${ts.replace('.', '')}`
  if (threadTs && threadTs !== ts) url += `?thread_ts=${threadTs}&cid=${channelId}`
  return url
}

/** Slack wraps links as `<url|label>`; the plain URL is what the app shows and parses. */
export function plainLinks(text: string): string {
  return text.replace(/<(https?:\/\/[^|>\s]+)(?:\|[^>]*)?>/g, '$1')
}

/**
 * Message text as people read it: links unwrapped, `<@U123|name>` as `@name`, `<#C1|chan>` as
 * `#chan`, and the entities Slack escapes put back.
 */
export function plainText(text: string): string {
  return plainLinks(text)
    .replace(/<@([A-Z0-9]+)\|([^>]+)>/g, '@$2')
    .replace(/<@([A-Z0-9]+)>/g, '@$1')
    .replace(/<#([A-Z0-9]+)\|([^>]*)>/g, (_m, id: string, name: string) => `#${name || id}`)
    .replace(/<!(here|channel|everyone)>/g, '@$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/** A thread title from a first line: at most `limit` characters, cut at a word boundary with "…". */
export function threadTitle(line: string, limit = 80): string {
  const trimmed = line.trim()
  const chars = Array.from(trimmed)
  if (chars.length <= limit) return trimmed
  const cut = chars.slice(0, limit).join('')
  const boundary = cut.search(/\s\S*$/)
  // A boundary in the first half would throw most of the line away: cut the word instead.
  const kept = boundary >= cut.length / 2 ? cut.slice(0, boundary) : cut
  return kept.replace(/[\s,;:-]+$/, '') + '…'
}

const RECOGNIZERS = [githubRecognizer(), gitlabRecognizer()]
const ANY_PROJECT_KEY: readonly TicketKeyProvider[] = [{ provider: 'jira' }]

/** Every PR/MR URL in the text, canonical and without repeats. */
export function pullRequestsIn(text: string): string[] {
  return findPullRequestRefs(plainLinks(text), RECOGNIZERS).map((r) => canonicalUrl(r.url))
}

/** Ticket keys in the text (`ABC-123`), for the given trackers or any project key. */
export function ticketsIn(text: string, providers: readonly TicketKeyProvider[] = ANY_PROJECT_KEY): string[] {
  return ticketKeysIn(plainLinks(text), providers)
}

/** The owner (`org` of `github.com/org/repo/pull/1`) of a PR URL, lower-case. */
export function pullRequestOwner(url: string): string | null {
  const m = /^https?:\/\/[^/]+\/([^/]+)\//.exec(url)
  return m ? m[1]!.toLowerCase() : null
}

/** Whether a chat author is the user (by the display name the source reported for them). */
export function isMe(user: string, me: string): boolean {
  const norm = (s: string) => s.replace(/^[@\s]+|\s+$/g, '').toLowerCase()
  return Boolean(me) && norm(user) === norm(me)
}
