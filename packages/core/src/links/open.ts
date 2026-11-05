import type { WorkhubConfig } from '../config/schema'
import { CHROME_PROFILE_DIR, type Profile } from '../domain/profile'
import { parsePermalink } from '../chat/links'

// How an external link is opened (Workhub 1's "Open links with" per profile, plus Slack deep links).
// Everything here is pure: the main process runs the commands these functions describe.

/** The Chrome app used when a profile picks a Chrome profile without naming the app. */
export const DEFAULT_CHROME_APP = 'Google Chrome'

/** A web link: the only kind the app ever hands to a browser. */
export function isWebUrl(url: string): boolean {
  return /^https?:\/\/[^\s/]/i.test(url)
}

export type LinkKind = 'slack' | 'web' | 'invalid'

const SLACK_HOST = /^https?:\/\/([\w.-]+\.)?slack\.com(?:[/?#:]|$)/i

/** `slack` for a link on a slack.com workspace, `web` for any other http(s) link, else `invalid`. */
export function classifyUrl(url: string): LinkKind {
  if (!isWebUrl(url)) return 'invalid'
  return SLACK_HOST.test(url) ? 'slack' : 'web'
}

/** What a Slack link points to; `team` is only known for `app.slack.com/client/<team>/<channel>`. */
export interface SlackTarget {
  host: string
  channelId: string
  team?: string
  ts?: string
  /** The thread the message belongs to (`thread_ts`), or the message itself. */
  rootTs?: string
}

const SLACK_CLIENT = /^https?:\/\/(app\.slack\.com)\/client\/([A-Z0-9]+)\/([A-Z0-9]+)/

/** The channel (and message) a Slack link opens; null for a link the app has no deep link for. */
export function slackTarget(url: string): SlackTarget | null {
  if (classifyUrl(url) !== 'slack') return null
  const permalink = parsePermalink(url)
  if (permalink) return { host: permalink.host.toLowerCase(), channelId: permalink.channelId, ts: permalink.ts, rootTs: permalink.rootTs }
  const client = SLACK_CLIENT.exec(url)
  if (client) return { host: client[1]!, team: client[2]!, channelId: client[3]! }
  return null
}

/**
 * `slack://channel?team=…&id=…&message=…` for the Slack desktop app. The app ignores an https
 * permalink handed to it, so the message goes in the deep link, with `thread_ts` for a reply.
 * Null without a team id.
 */
export function slackDeepLink(target: SlackTarget, team: string | undefined): string | null {
  const teamId = target.team ?? team
  if (!teamId) return null
  let link = `slack://channel?team=${encodeURIComponent(teamId)}&id=${encodeURIComponent(target.channelId)}`
  if (target.ts) link += `&message=${encodeURIComponent(target.ts)}`
  if (target.ts && target.rootTs && target.rootTs !== target.ts) link += `&thread_ts=${encodeURIComponent(target.rootTs)}`
  return link
}

/** One entry of Chrome's profile list. */
export interface ChromeProfile {
  /** The directory name inside Chrome's user data folder (`Default`, `Profile 1`): what `--profile-directory` takes. */
  dir: string
  /** The name Chrome shows for the profile. */
  name: string
}

/**
 * The profiles in the text of Chrome's `Local State` file (`profile.info_cache`: directory →
 * info), `Default` first, then by directory. Anything unreadable gives an empty list.
 */
export function parseChromeProfiles(localState: string): ChromeProfile[] {
  let cache: unknown
  try {
    cache = (JSON.parse(localState) as { profile?: { info_cache?: unknown } } | null)?.profile?.info_cache
  } catch {
    return []
  }
  if (!cache || typeof cache !== 'object' || Array.isArray(cache)) return []
  const out: ChromeProfile[] = []
  for (const [dir, info] of Object.entries(cache)) {
    if (!CHROME_PROFILE_DIR.test(dir)) continue
    const name = (info as { name?: unknown } | null)?.name
    out.push({ dir, name: typeof name === 'string' && name.trim() ? name.trim() : dir })
  }
  return out.sort((a, b) => (a.dir === 'Default' ? -1 : b.dir === 'Default' ? 1 : a.dir.localeCompare(b.dir, 'en', { numeric: true })))
}

/** A command to run to open a link; the link is always one argument, never part of a shell string. */
export interface LinkCommand {
  command: string
  args: string[]
}

/**
 * The words of a quoted command line: `"/opt/My Tools/open" -P work` is the executable
 * `/opt/My Tools/open` and the arguments `-P`, `work`. Double or single quotes group words; inside
 * double quotes `\"` is a literal quote. Backslashes are otherwise literal (Windows paths). Null for
 * an unterminated quote. Nothing is expanded: no variables, globs or pipes.
 */
export function splitCommandLine(text: string): string[] | null {
  const words: string[] = []
  let word = ''
  let inWord = false
  let quote: '"' | "'" | null = null
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (quote) {
      if (c === quote) quote = null
      else if (quote === '"' && c === '\\' && text[i + 1] === '"') word += text[++i]
      else word += c
    } else if (c === '"' || c === "'") {
      quote = c
      inWord = true
    } else if (/\s/.test(c)) {
      if (inWord) words.push(word)
      word = ''
      inWord = false
    } else {
      word += c
      inWord = true
    }
  }
  if (quote) return null
  if (inWord) words.push(word)
  return words
}

/**
 * The executable and arguments of a custom link command. A command that starts with a quote is a
 * command line (`"firefox" -P work`); any other is one executable, spaces included, as before.
 */
export function customCommandParts(command: string): { executable: string; args: string[] } | null {
  const text = command.trim()
  if (!text) return null
  if (!text.startsWith('"') && !text.startsWith("'")) return { executable: text, args: [] }
  const words = splitCommandLine(text)
  if (!words?.length || !words[0]) return null
  return { executable: words[0], args: words.slice(1) }
}

/** A command line that `customCommandParts` reads back as these words; the executable is always quoted. */
export function joinCommandLine(executable: string, args: readonly string[]): string {
  const quote = (w: string) => `"${w.replace(/"/g, '\\"')}"`
  return [quote(executable), ...args.map((a) => (a && !/[\s"']/.test(a) ? a : quote(a)))].join(' ')
}

/**
 * How to open a web link in the browser a profile chose; null means "use the default browser".
 * `browser` is an application name on macOS (`open -a`) and an executable elsewhere. With a
 * `chromeProfile` (macOS only), a new Chrome instance starts on that profile directory. A custom
 * `command` wins over both and gets the link as its last argument, after the arguments of a
 * quoted command line (see `customCommandParts`).
 */
export function linkLaunch(platform: string, setting: { browser?: string; chromeProfile?: string; command?: string }, url: string): LinkCommand | null {
  if (!isWebUrl(url)) return null
  const custom = setting.command?.trim()
  if (custom) {
    // An executable (a name on the PATH or a path) with optional arguments. `env` resolves it on the
    // login-shell PATH like Workhub 1 did; a leading `-` would be an option of `env`, so it is refused.
    if (/[\r\n\0]/.test(custom)) return null
    const parts = customCommandParts(custom)
    if (!parts || parts.executable.startsWith('-')) return null
    const args = [...parts.args, url]
    return platform === 'win32' ? { command: parts.executable, args } : { command: '/usr/bin/env', args: [parts.executable, ...args] }
  }
  const browser = setting.browser?.trim()
  const chromeProfile = setting.chromeProfile?.trim()
  if (platform === 'darwin') {
    if (chromeProfile && CHROME_PROFILE_DIR.test(chromeProfile)) {
      return { command: 'open', args: ['-na', browser || DEFAULT_CHROME_APP, '--args', `--profile-directory=${chromeProfile}`, url] }
    }
    return browser ? { command: 'open', args: ['-a', browser, url] } : null
  }
  return browser ? { command: browser, args: [url] } : null
}

/** GitHub owners named by a search scope (`org:acme user:me repo:acme/api`), lowercased. */
function scopeOwners(scope: string | undefined): string[] {
  const owners: string[] = []
  for (const m of (scope ?? '').matchAll(/\b(?:org|user|repo):([^/\s]+)/gi)) owners.push(m[1]!.toLowerCase())
  return owners
}

function hostOf(url: string): string {
  return /^https?:\/\/([^/:?#]+)/i.exec(url)?.[1]?.toLowerCase() ?? ''
}

/**
 * The profile a link belongs to: the one whose Jira site is the link's host, or whose GitHub
 * scope names the owner in the path (Workhub 1 routed links the same way); else the given
 * profile, else the active one.
 */
export function profileForLink(config: Pick<WorkhubConfig, 'connections' | 'profiles' | 'activeProfileId'>, url: string, profileId?: string | null): Profile | undefined {
  const byId = (id: string | null | undefined) => config.profiles.find((p) => p.id === id)
  if (profileId) return byId(profileId)
  const host = hostOf(url)
  const owner = /^https?:\/\/[^/]+\/([^/?#]+)/i.exec(url)?.[1]?.toLowerCase()
  for (const profile of config.profiles) {
    const tracker = config.connections.find((c) => c.id === profile.connections.tracker)
    if (tracker?.endpoint && hostOf(tracker.endpoint) === host) return profile
    const codeHost = config.connections.find((c) => c.id === profile.connections.codeHost)
    if (owner && host === 'github.com' && codeHost && scopeOwners(codeHost.settings['scope']).includes(owner)) return profile
  }
  return byId(config.activeProfileId)
}

/**
 * The name of a Chrome app's data folder under `~/Library/Application Support/Google` (Chrome's
 * own is `Chrome`; a separate copy such as `Chrome Work.app` conventionally uses `Chrome Work`).
 * Null for a name that cannot be a folder name.
 */
export function chromeDataDirName(app: string | undefined): string | null {
  const name = (app?.trim() || DEFAULT_CHROME_APP).replace(/\/+$/, '').split('/').pop()!.replace(/\.app$/i, '').replace(/^Google /, '')
  return name && !name.startsWith('.') && !/[\0]/.test(name) ? name : null
}

/**
 * What Workhub 1's `linkOpener` becomes: `open -a X` is the browser app X; any other command stays a
 * command. Workhub 1 ran the opener through a shell, so one with arguments (`firefox -P work`) is
 * split into words and stored as a quoted command line (`"firefox" -P work`) that `linkLaunch`
 * passes word by word.
 */
export function importedLinkOpener(opener: string | undefined): { linkBrowser: string } | { linkCommand: string } | null {
  const text = opener?.trim()
  if (!text) return null
  const app = /^open\s+-a\s+(?:"([^"]+)"|'([^']+)'|([^\s"']+))$/.exec(text)
  const name = app?.[1] ?? app?.[2] ?? app?.[3]
  if (name) return { linkBrowser: name }
  const words = splitCommandLine(text)
  if (!words?.length || !words[0]) return { linkCommand: text }
  const [executable, ...args] = words as [string, ...string[]]
  // A single unquoted word keeps the plain form a person would type in Settings.
  if (!args.length && !/[\s"']/.test(executable)) return { linkCommand: executable }
  return { linkCommand: joinCommandLine(executable, args) }
}
