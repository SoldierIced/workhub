/**
 * Reads Workhub 1's settings, read-only, for the import in Settings → General. Workhub 1 is a
 * macOS app that keeps them in UserDefaults; `defaults export <domain> -` prints them as an XML
 * property list without changing anything. Its JSON values are stored as `<data>` (base64).
 */
import { execFile } from 'node:child_process'
import { WORKHUB1_APPEARANCE_KEYS, WORKHUB1_NOTIFICATION_CATEGORIES, type Workhub1Observability, type Workhub1Settings } from '@workhub/core'

export const WORKHUB1_DOMAIN = 'com.nehuenfortes.workhub'

export type PlistValue = string | number | boolean | Date | Uint8Array | PlistValue[] | { [key: string]: PlistValue }

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function unescape(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
    return ENTITIES[e] ?? m
  })
}

/** A small XML property list parser: dict, array, string, data, integer, real, date, true, false. */
export function parsePlist(xml: string): PlistValue {
  const tokens = [...xml.matchAll(/<(\/?)([a-z]+)(?:\s[^>]*?)?\s*(\/?)>|([^<]+)/gi)]
  let i = 0
  const next = () => tokens[i++]
  const text = (): string => {
    const t = tokens[i]
    if (t && t[4] !== undefined) {
      i++
      return unescape(t[4])
    }
    return ''
  }
  const close = (tag: string) => {
    const t = next()
    if (!t || t[1] !== '/' || t[2] !== tag) throw new Error(`malformed plist near <${tag}>`)
  }
  const value = (): PlistValue => {
    let t = next()
    while (t && t[4] !== undefined) t = next() // whitespace between elements
    if (!t) throw new Error('unexpected end of plist')
    const tag = t[2]!
    const empty = t[3] === '/'
    switch (tag) {
      case 'dict': {
        const out: Record<string, PlistValue> = {}
        if (empty) return out
        for (;;) {
          let k = next()
          while (k && k[4] !== undefined) k = next()
          if (!k) throw new Error('unterminated dict')
          if (k[1] === '/' && k[2] === 'dict') return out
          if (k[2] !== 'key') throw new Error('expected a key in dict')
          const key = text()
          close('key')
          out[key] = value()
        }
      }
      case 'array': {
        const out: PlistValue[] = []
        if (empty) return out
        for (;;) {
          while (tokens[i] && tokens[i]![4] !== undefined) i++
          const t2 = tokens[i]
          if (!t2) throw new Error('unterminated array')
          if (t2[1] === '/' && t2[2] === 'array') {
            i++
            return out
          }
          out.push(value())
        }
      }
      case 'true':
      case 'false':
        return tag === 'true'
      case 'string':
      case 'key': {
        if (empty) return ''
        const s = text()
        close(tag)
        return s
      }
      case 'integer':
      case 'real': {
        const s = text()
        close(tag)
        return Number(s.trim())
      }
      case 'date': {
        const s = text()
        close(tag)
        return new Date(s.trim())
      }
      case 'data': {
        if (empty) return new Uint8Array()
        const s = text()
        close(tag)
        return Uint8Array.from(Buffer.from(s.replace(/\s+/g, ''), 'base64'))
      }
      default:
        throw new Error(`unsupported plist element <${tag}>`)
    }
  }
  // Skip the prolog and the <plist> wrapper.
  while (i < tokens.length && tokens[i]![2] !== 'plist') i++
  i++
  return value()
}

/** A UserDefaults value Workhub 1 wrote as JSON: `<data>` with UTF-8 JSON inside (or a JSON string). */
function json(value: PlistValue | undefined): unknown {
  if (value instanceof Uint8Array) {
    try {
      return JSON.parse(Buffer.from(value).toString('utf8'))
    } catch {
      return undefined
    }
  }
  if (typeof value === 'string') {
    try {
      return JSON.parse(value)
    } catch {
      return undefined
    }
  }
  return undefined
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && !(v instanceof Uint8Array)

const OBSERVABILITY_PREFIX = 'settings.observability.'
const MODEL_PREFIX = 'session.model.'
const EFFORT_PREFIX = 'session.effort.'

/**
 * The parts of Workhub 1's defaults that Workhub 2 imports or reports. Runtime state (runs,
 * cursors, seen events, snapshots, flows) is never read into the result.
 */
export function workhub1SettingsFromPlist(xml: string): Workhub1Settings {
  const root = parsePlist(xml)
  if (!isRecord(root)) return {}
  const dict = root as Record<string, PlistValue>
  const settings: Workhub1Settings = {}
  const object = (key: string) => {
    const v = json(dict[key])
    return isRecord(v) ? v : undefined
  }
  const list = (key: string) => {
    const v = json(dict[key])
    return Array.isArray(v) ? v : undefined
  }
  const bool = (key: string) => (typeof dict[key] === 'boolean' ? (dict[key] as boolean) : undefined)
  const number = (key: string) => (typeof dict[key] === 'number' ? (dict[key] as number) : undefined)
  const string = (key: string) => (typeof dict[key] === 'string' ? (dict[key] as string) : undefined)

  const main = object('settings.claude.main')
  if (main) settings.mainAccount = main as Workhub1Settings['mainAccount']
  const second = object('settings.claude.second')
  if (second) settings.secondAccount = second as Workhub1Settings['secondAccount']
  const profiles = list('profiles.definitions')
  if (profiles) settings.profiles = profiles as Workhub1Settings['profiles']
  const jira = object('connections.jira')
  if (jira) settings.jira = jira as Workhub1Settings['jira']
  const automations = list('automations.items')
  if (automations) settings.automations = automations as Workhub1Settings['automations']
  const slack = object('slack.settings')
  if (slack) settings.slack = slack as Workhub1Settings['slack']
  const threads = list('slack.threads')
  if (threads) settings.slackThreads = threads.filter(isRecord).map((t) => ({ closed: t['closed'] === true }))
  const openSessions = object('workbench.openSessions')
  if (openSessions) settings.openSessions = openSessions as Workhub1Settings['openSessions']

  for (const key of Object.keys(dict)) {
    if (key.startsWith(OBSERVABILITY_PREFIX)) {
      const obs = object(key)
      if (obs) settings.observability = { ...settings.observability, [key.slice(OBSERVABILITY_PREFIX.length)]: obs as Workhub1Observability }
    } else if (key.startsWith(MODEL_PREFIX) && string(key)) {
      settings.sessionModels = { ...settings.sessionModels, [key.slice(MODEL_PREFIX.length)]: string(key)! }
    } else if (key.startsWith(EFFORT_PREFIX) && string(key)) {
      settings.sessionEfforts = { ...settings.sessionEfforts, [key.slice(EFFORT_PREFIX.length)]: string(key)! }
    }
  }

  const notifications: NonNullable<Workhub1Settings['notifications']> = {}
  if (bool('settings.notifications') !== undefined) notifications.all = bool('settings.notifications')!
  for (const category of WORKHUB1_NOTIFICATION_CATEGORIES) {
    const v = bool(`settings.notifications.${category}`)
    if (v !== undefined) notifications[category] = v
  }
  if (Object.keys(notifications).length) settings.notifications = notifications
  const healthAlerts = bool('settings.healthAlerts')
  if (healthAlerts !== undefined) settings.healthAlerts = healthAlerts
  const prBabysitter = bool('settings.prBabysitter')
  if (prBabysitter !== undefined) settings.prBabysitter = prBabysitter
  const healthRefresh = number('settings.healthRefreshMinutes')
  if (healthRefresh !== undefined) settings.healthRefreshMinutes = healthRefresh
  const usageRefresh = number('settings.usageRefreshMinutes')
  if (usageRefresh !== undefined) settings.usageRefreshMinutes = usageRefresh
  const usageChecker = string('settings.usageChecker')
  if (usageChecker !== undefined) settings.usageChecker = usageChecker
  const promptLanguage = string('settings.promptLanguage')
  if (promptLanguage !== undefined) settings.promptLanguage = promptLanguage
  const appleLanguages = dict['AppleLanguages']
  const appLanguage = string('settings.appLanguage') ?? (Array.isArray(appleLanguages) && typeof appleLanguages[0] === 'string' ? appleLanguages[0] : undefined)
  if (appLanguage !== undefined && appLanguage !== 'system') settings.appLanguage = appLanguage
  const sidebarProfile = string('sidebar.profile')
  if (sidebarProfile) settings.sidebarProfile = sidebarProfile

  const appearance: NonNullable<Workhub1Settings['appearance']> = {}
  for (const key of WORKHUB1_APPEARANCE_KEYS) {
    const v = dict[key]
    if (typeof v === 'string' || typeof v === 'number') appearance[key] = v
  }
  if (Object.keys(appearance).length) settings.appearance = appearance
  return settings
}

/** Runs `defaults export` (read-only). Only on macOS; null when Workhub 1 has no settings there. */
export function readWorkhub1Settings(domain = WORKHUB1_DOMAIN): Promise<Workhub1Settings | null> {
  if (process.platform !== 'darwin') return Promise.resolve(null)
  return new Promise((resolve, reject) => {
    execFile('defaults', ['export', domain, '-'], { maxBuffer: 32 * 1024 * 1024, timeout: 20_000 }, (err, stdout) => {
      if (err) {
        // `defaults export` fails for a domain that does not exist.
        resolve(null)
        return
      }
      try {
        resolve(workhub1SettingsFromPlist(stdout))
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })
  })
}
