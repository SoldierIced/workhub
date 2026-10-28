import type { AgentAccount } from '../domain/agent'
import { findProvider, type Connection } from '../domain/connection'
import { NO_MODULES, OPTIONAL_MODULES, type FolderOptions, type Profile } from '../domain/profile'
import { normalizeFolder } from '../domain/profile-folders'
import { EMPTY_SESSION_GROUPS, type GroupMember, type SessionGroup, type SessionGroups, type TopSlot } from '../domain/session-groups'
import { DEFAULT_OPTIONS, type AppOptions, type WorkhubConfig } from '../config/schema'
import type { AutomationDefinition, PendingGate } from '../automations/types'
import { MIN_WATCH_INTERVAL_MINUTES, type ChatWatcherSettings } from '../chat/types'
import {
  DEFAULT_HEALTH_THRESHOLDS,
  HEALTH_CONNECTION_SETTINGS,
  HEALTH_THRESHOLD_RANGES,
  MAX_HEALTH_REFRESH_MINUTES,
  MIN_HEALTH_REFRESH_MINUTES,
  type HealthEnvironment,
  type HealthThresholds
} from '../health/types'
import { PR_EVENT_KINDS, type PrEventToggles } from '../pr-events/types'
import { importedLinkOpener } from '../links/open'
import { DEFAULT_AI_REVIEW_SETTINGS } from '../ai-review/defaults'
import { DEFAULT_PROTECTED_BRANCHES } from '../codehost/usecases'
import { effectiveAgentKey } from './effective-agents'
import { commitImported } from './configuration'
import type { Result } from './validation'

/**
 * Workhub 1's settings, as its UserDefaults hold them (each value is JSON Workhub 1 encoded, or a
 * plain value). Only the parts Workhub 2 maps or reports are typed; anything else is ignored.
 */
export interface Workhub1Settings {
  /** `settings.claude.main` */
  mainAccount?: Workhub1Account
  /** `settings.claude.second` */
  secondAccount?: Workhub1Account
  /** `profiles.definitions` */
  profiles?: Workhub1Profile[]
  /** `connections.jira`: profile id -> Jira connection. */
  jira?: Record<string, Workhub1Jira>
  /** `automations.items` */
  automations?: Workhub1Automation[]
  /** `slack.settings` */
  slack?: Workhub1Slack
  /** `slack.threads`: only how many are still open matters (they are not imported). */
  slackThreads?: { closed?: boolean }[]
  /** `settings.observability.<profile id>`: profile id -> Elasticsearch setup. */
  observability?: Record<string, Workhub1Observability>
  /** `settings.healthRefreshMinutes` */
  healthRefreshMinutes?: number
  /** `settings.healthAlerts` */
  healthAlerts?: boolean
  /** `settings.notifications` (the main switch) and `settings.notifications.<category>`, under `all` and the category. */
  notifications?: Partial<Record<'all' | Workhub1NotificationCategory, boolean>>
  /** `settings.usageChecker`: a fallback usageChecker checkout. */
  usageChecker?: string
  /** `settings.usageRefreshMinutes` */
  usageRefreshMinutes?: number
  /** `settings.protectedBranches`: the branches Close PR never deletes, as the comma-separated text of Settings → Flows. */
  protectedBranches?: string
  /** `settings.prBabysitter` */
  prBabysitter?: boolean
  /** `settings.promptLanguage`: `english` or `spanish`. */
  promptLanguage?: string
  /** `settings.appLanguage`, else the first of `AppleLanguages`. */
  appLanguage?: string
  /** `session.model.<account folder name>` (`.claude`, `.claude-work`). */
  sessionModels?: Record<string, string>
  /** `session.effort.<account folder name>` */
  sessionEfforts?: Record<string, string>
  /** `terminal.*`, `chat.fontSize`, `app.textSize`: mapped to the renderer's appearance preferences. */
  appearance?: Partial<Record<Workhub1AppearanceKey, string | number>>
  /** `workbench.openSessions` */
  openSessions?: Workhub1OpenSessions
  /** `sidebar.profile`: the profile last selected. */
  sidebarProfile?: string
}

export const WORKHUB1_APPEARANCE_KEYS = ['terminal.fontFamily', 'terminal.fontSize', 'terminal.theme', 'chat.fontSize', 'app.textSize'] as const
export type Workhub1AppearanceKey = (typeof WORKHUB1_APPEARANCE_KEYS)[number]

export const WORKHUB1_NOTIFICATION_CATEGORIES = ['sessionWaiting', 'sessionReplies', 'flows', 'health', 'pullRequests', 'tickets', 'slack', 'automations'] as const
export type Workhub1NotificationCategory = (typeof WORKHUB1_NOTIFICATION_CATEGORIES)[number]

export interface Workhub1Account {
  name?: string
  configDirectory?: string
  /** A wrapper command that starts the account in a terminal. */
  command?: string
}

export interface Workhub1Profile {
  id?: string
  name?: string
  folders?: { path?: string; onlyGitRepos?: boolean; isContainer?: boolean }[]
  /** Also owns everything outside every profile's folders. */
  catchesOtherFolders?: boolean
  githubScope?: string
  ticketPrefixes?: string[]
  sessionEnvironment?: { name?: string; value?: string }[]
  /** The profile's accent, `#rrggbb`. */
  color?: string
  /** The command that opened the profile's links (run with the link as its argument). */
  linkOpener?: string
}

export interface Workhub1Jira {
  site?: string
  keychainService?: string
  ignoredStatuses?: string[]
}

export interface Workhub1Automation {
  id?: string
  name?: string
  enabled?: boolean
  prompt?: string
  useSecondAccount?: boolean
  folder?: string
  model?: string
  effort?: string
  permissionMode?: string
  /** `app` or `console`. */
  viewMode?: string
  triggers?: { slackChannelIds?: string[]; prOwner?: string; intervalMinutes?: number | null; pendingGate?: { kind?: string; stateFile?: string } | null }
  /** `Calendar` weekdays: 1 = Sunday. */
  window?: { days?: number[]; startHour?: number; endHour?: number }
  limits?: { maxRuns?: number; perMinutes?: number; maxPerDay?: number | null }
  usageThreshold?: number
  sessionPolicy?: string
  runTimeoutMinutes?: number
  sessionID?: string
  receivesSlackReplies?: boolean | null
}

export interface Workhub1Slack {
  enabled?: boolean
  useSecondAccount?: boolean
  model?: string
  intervalMinutes?: number
  startHour?: number
  endHour?: number
  /** `Calendar` weekdays: 1 = Sunday. */
  weekdays?: number[]
  usageThreshold?: number
  channels?: { id?: string; name?: string; purpose?: string }[]
  /** The one profile Slack belongs to; absent means every profile. */
  profileID?: string | null
}

/** Swift enums with associated values encode as `{ "<case>": { ...values } }`. */
export interface Workhub1Observability {
  elasticURL?: string
  keychainItem?: string
  auth?: { apiKey?: unknown; basic?: { username?: string } }
  tls?: { system?: unknown; insecure?: unknown; pinned?: { sha256?: string } }
  environments?: {
    id?: string
    name?: string
    apmEnvironments?: string[]
    k8sIndexSuffix?: string
    hasKubeState?: boolean
    apm?: { errors?: string; traces?: string; metrics?: string }
    kibanaURL?: string
    thresholds?: Record<string, unknown>
  }[]
}

export interface Workhub1OpenSessions {
  sessions?: { sessionID?: string; kind?: string; folder?: string; name?: string | null; group?: string | null }[]
  groups?: { id?: string; name?: string; collapsed?: boolean }[]
  /** Group ids and the session ids of ungrouped sessions, in order. */
  top?: string[]
}

export type ImportNoteCode =
  /** A Workhub 2 item with the same id (or a section already set up) exists; the imported one is left out. */
  | 'exists'
  /** A secret (token) lives in Workhub 1's Keychain item; it is not copied and must be entered again. */
  | 'reenterSecret'
  /** The Workhub 1 setting has no Workhub 2 equivalent yet. */
  | 'notSupported'

export interface ImportNote {
  code: ImportNoteCode
  /**
   * What it is about: `profiles.<id>`, `accounts.<id>`, `connections.<id>`, `automations.<id>`,
   * `chatWatcher`, `options`, `sessionGroups`, or `settings` for app-wide Workhub 1 settings.
   */
  path: string
  /** What was left out, e.g. `command` or `terminal.fontSize`. */
  detail?: string
}

/** Preferences Workhub 2 keeps in the renderer (not in config.json); the renderer applies them. */
export interface ImportPrefs {
  /** The model new sessions start with, per agent key (`claude:<account id>`). */
  models?: Record<string, string>
  language?: 'en' | 'es'
  /** Workhub 1's terminal theme and font, and its text sizes (the renderer clamps them into its ranges). */
  appearance?: ImportAppearance
}

/** Settings → Appearance values carried over from Workhub 1. */
export interface ImportAppearance {
  /** `terminal.theme`: a color scheme name of the shared iTerm2-Color-Schemes catalog. */
  terminalTheme?: string
  /** `terminal.fontFamily`; Workhub 1's empty value (its default) is not carried. */
  terminalFontFamily?: string
  /** `terminal.fontSize`, in points (pixels in Workhub 2). */
  terminalFontSize?: number
  /** `chat.fontSize` */
  chatFontSize?: number
  /** `app.textSize` */
  textSize?: number
}

/** Workhub 1's appearance settings as Workhub 2 preferences; empty or unreadable values are left out. */
export function appearanceFrom(values: Workhub1Settings['appearance']): ImportAppearance | undefined {
  const text = (key: Workhub1AppearanceKey) => {
    const v = values?.[key]
    return typeof v === 'string' && v.trim() ? v.trim() : undefined
  }
  const size = (key: Workhub1AppearanceKey) => {
    const v = values?.[key]
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
    return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined
  }
  const out: ImportAppearance = {}
  const theme = text('terminal.theme')
  if (theme) out.terminalTheme = theme
  const family = text('terminal.fontFamily')
  if (family) out.terminalFontFamily = family
  const terminalFontSize = size('terminal.fontSize')
  if (terminalFontSize) out.terminalFontSize = terminalFontSize
  const chatFontSize = size('chat.fontSize')
  if (chatFontSize) out.chatFontSize = chatFontSize
  const textSize = size('app.textSize')
  if (textSize) out.textSize = textSize
  return Object.keys(out).length ? out : undefined
}

export interface ImportPlan {
  profiles: Profile[]
  accounts: AgentAccount[]
  connections: Connection[]
  automations?: AutomationDefinition[]
  chatWatcher?: ChatWatcherSettings
  /** Only the options Workhub 1 had an equivalent for; the rest keep Workhub 2's defaults. */
  options?: Partial<AppOptions>
  sessionGroups?: SessionGroups
  activeProfileId?: string
  prefs?: ImportPrefs
  notes: ImportNote[]
}

/** A Workhub 2 id from any name: lowercase, `[a-z0-9._-]`, starting with a letter or digit. */
export function slugId(value: string, fallback: string): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/-+$/, '')
    .slice(0, 64)
  return slug || fallback
}

/** `~` and `~/x` expanded against `home` (Workhub 1 is macOS-only, so `/` separates). */
export function expandHome(path: string, home: string): string {
  if (path === '~') return home
  if (path.startsWith('~/')) return `${home.replace(/\/+$/, '')}/${path.slice(2)}`
  return path
}

function normalizedDir(path: string): string {
  return path.replace(/\/+$/, '')
}

/**
 * Workhub 1's folder switches ("Only git repos", "Each subfolder is its own project") and "also
 * owns everything outside" for profiles imported before those were imported: the profiles with the
 * same id get each switch Workhub 1 turned on, only where the Workhub 2 profile leaves it unset (a
 * value set in Workhub 2, on or off, is never changed). Returns the profiles that changed.
 */
export function fillWorkhub1FolderFlags(v1: Workhub1Settings, config: Pick<WorkhubConfig, 'profiles'>, home: string): Profile[] {
  const changed: Profile[] = []
  let ownerTaken = config.profiles.some((p) => p.ownsOutside === true)
  for (const [index, p] of (v1.profiles ?? []).entries()) {
    const target = config.profiles.find((x) => x.id === slugId(p.id ?? p.name ?? '', `profile-${index + 1}`))
    if (!target) continue
    let next = target
    const options: Record<string, FolderOptions> = { ...target.folderOptions }
    let touched = false
    for (const f of p.folders ?? []) {
      const path = f.path?.trim()
      if (!path || (!f.onlyGitRepos && !f.isContainer)) continue
      const dir = normalizeFolder(normalizedDir(expandHome(path, home)), home)
      const folder = (target.folders ?? []).find((x) => normalizeFolder(x, home) === dir)
      if (folder === undefined) continue
      const key = Object.keys(options).find((k) => normalizeFolder(k, home) === dir) ?? folder
      const current = options[key] ?? {}
      const patch: FolderOptions = {
        ...(f.onlyGitRepos && current.onlyGitRepos === undefined ? { onlyGitRepos: true } : {}),
        ...(f.isContainer && current.subfoldersAreProjects === undefined ? { subfoldersAreProjects: true } : {})
      }
      if (!Object.keys(patch).length) continue
      options[key] = { ...current, ...patch }
      touched = true
    }
    if (touched) next = { ...next, folderOptions: options }
    if (p.catchesOtherFolders && !ownerTaken && target.ownsOutside === undefined) {
      next = { ...next, ownsOutside: true }
      ownerTaken = true
    }
    const opener = importedLinkOpener(p.linkOpener)
    if (opener && !target.linkBrowser && !target.linkCommand && !target.linkChromeProfile) next = { ...next, ...opener }
    if (next !== target) changed.push(next)
  }
  return changed
}

function siteUrl(site: string): string {
  const trimmed = site.trim().replace(/\/+$/, '')
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

const basename = (path: string): string => normalizedDir(path).split('/').pop() ?? path

const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, Math.round(n)))
const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
const hour = (v: unknown, fallback: number): number => clamp(num(v, fallback), 0, 24)

/** Workhub 1's `Calendar` weekdays (1 = Sunday) as JavaScript weekdays (0 = Sunday), sorted. */
export function jsWeekdays(days: number[] | undefined, fallback: number[]): number[] {
  if (!days) return fallback
  return [...new Set(days.filter((d) => Number.isInteger(d) && d >= 1 && d <= 7).map((d) => d - 1))].sort((a, b) => a - b)
}

function thresholdsFrom(v1: Record<string, unknown> | undefined): HealthThresholds {
  const out: HealthThresholds = { ...DEFAULT_HEALTH_THRESHOLDS }
  for (const k of Object.keys(HEALTH_THRESHOLD_RANGES) as (keyof typeof HEALTH_THRESHOLD_RANGES)[]) {
    const [min, max] = HEALTH_THRESHOLD_RANGES[k]
    out[k] = clamp(num(v1?.[k], DEFAULT_HEALTH_THRESHOLDS[k]), min, max)
  }
  if (typeof v1?.['silentServicesDegrade'] === 'boolean') out.silentServicesDegrade = v1['silentServicesDegrade']
  return out
}

function healthEnvironments(obs: Workhub1Observability): HealthEnvironment[] {
  return (obs.environments ?? [])
    .filter((e) => e.id?.trim())
    .map((e) => ({
      id: e.id!.trim(),
      name: e.name?.trim() || e.id!.trim(),
      apmEnvironments: (e.apmEnvironments ?? []).map((s) => s.trim()).filter(Boolean),
      k8sIndexSuffix: e.k8sIndexSuffix?.trim() ?? '',
      hasKubeState: e.hasKubeState === true,
      apm: { errors: e.apm?.errors?.trim() ?? '', traces: e.apm?.traces?.trim() ?? '', metrics: e.apm?.metrics?.trim() ?? '' },
      kibanaUrl: e.kibanaURL?.trim() ?? '',
      thresholds: thresholdsFrom(e.thresholds)
    }))
}

/** The `health` connection settings: auth mode, user name and TLS policy. The password or API key is never read. */
function healthConnectionSettings(obs: Workhub1Observability): Record<string, string> {
  const s: Record<string, string> = {}
  const username = obs.auth?.basic?.username?.trim()
  if (obs.auth?.basic) {
    s[HEALTH_CONNECTION_SETTINGS.auth] = 'basic'
    if (username) s[HEALTH_CONNECTION_SETTINGS.username] = username
  } else s[HEALTH_CONNECTION_SETTINGS.auth] = 'apiKey'
  if (obs.tls?.pinned) {
    s[HEALTH_CONNECTION_SETTINGS.tls] = 'pinned'
    const fp = obs.tls.pinned.sha256?.trim()
    if (fp) s[HEALTH_CONNECTION_SETTINGS.fingerprint] = fp
  } else s[HEALTH_CONNECTION_SETTINGS.tls] = obs.tls?.insecure ? 'insecure' : 'system'
  return s
}

const isUnder = (path: string, folder: string): boolean => path === folder || path.startsWith(`${folder}/`)

/**
 * Maps Workhub 1's settings onto Workhub 2's config, without touching either: profiles with their
 * folders and modules, both Claude accounts, each profile's GitHub, Jira and Elastic connection,
 * automations, the Slack watcher, the app options with an equivalent, the sidebar session groups
 * and the renderer preferences (model per account, language). Ids that already exist, and
 * sections the Workhub 2 config already has, are left out; secrets are never imported (Workhub 1
 * keeps them in the Keychain). Runtime state (runs, cursors, seen events, snapshots) is not
 * imported: Workhub 2's first PR sync and first Slack read only learn what is there, so nothing old
 * is notified again.
 */
export function planWorkhub1Import(v1: Workhub1Settings, current: WorkhubConfig, home: string): ImportPlan {
  const plan: ImportPlan = { profiles: [], accounts: [], connections: [], automations: [], notes: [] }
  const taken = {
    profiles: new Set(current.profiles.map((p) => p.id)),
    accounts: new Set(current.accounts.map((a) => a.id)),
    connections: new Set(current.connections.map((c) => c.id)),
    automations: new Set((current.automations ?? []).map((a) => a.id))
  }
  const claim = (list: keyof typeof taken, id: string): boolean => {
    if (taken[list].has(id)) {
      plan.notes.push({ code: 'exists', path: `${list}.${id}` })
      return false
    }
    taken[list].add(id)
    return true
  }
  const note = (code: ImportNoteCode, path: string, detail?: string) => plan.notes.push(detail === undefined ? { code, path } : { code, path, detail })

  // Accounts. Their ids are referenced (automations, Slack, groups) even when the account already exists.
  const defaultDir = normalizedDir(expandHome('~/.claude', home))
  const accountIds: string[] = []
  const accountRef: { main?: string; second?: string } = {}
  const accountByFolderName = new Map<string, string>()
  for (const [slot, fallbackName, v1Account] of [
    ['main', 'Claude', v1.mainAccount],
    ['second', 'Claude 2', v1.secondAccount]
  ] as const) {
    if (!v1Account) continue
    const name = (v1Account.name ?? '').split(/\s+/).filter(Boolean).join(' ') || fallbackName
    const id = slugId(`claude-${name}`, 'claude-account')
    const dir = normalizedDir(expandHome(v1Account.configDirectory?.trim() || '~/.claude', home))
    const account: AgentAccount = { id, agentId: 'claude', name }
    // The default folder runs without CLAUDE_CONFIG_DIR, as in Workhub 1.
    if (dir !== defaultDir) account.configDir = dir
    accountRef[slot] = id
    if (!accountByFolderName.has(basename(dir))) accountByFolderName.set(basename(dir), id)
    if (v1Account.command?.trim()) note('notSupported', `accounts.${id}`, 'command')
    if (!claim('accounts', id)) continue
    plan.accounts.push(account)
    accountIds.push(id)
  }
  const keyOf = (accountId: string | undefined) => effectiveAgentKey('claude', accountId ?? null)
  const accountFor = (useSecond: boolean | undefined) => (useSecond && accountRef.second ? accountRef.second : accountRef.main)

  // Profiles, with their GitHub, Jira and Elastic connections.
  const profileId = new Map<string, string>()
  const profileFolders: { id: string; folder: string }[] = []
  const newProfiles = new Map<string, Profile>()
  const usesSpanish = v1.promptLanguage === 'spanish'
  for (const [index, p] of (v1.profiles ?? []).entries()) {
    const id = slugId(p.id ?? p.name ?? '', `profile-${index + 1}`)
    if (p.id) profileId.set(p.id, id)
    const folders = (p.folders ?? []).map((f) => f.path?.trim()).filter((x): x is string => !!x).map((x) => normalizedDir(expandHome(x, home)))
    for (const folder of folders) profileFolders.push({ id, folder })
    // A profile left out takes its connections with it.
    if (!claim('profiles', id)) continue
    const profile: Profile = {
      id,
      name: p.name?.trim() || id,
      connections: {},
      // Workhub 1's accounts serve every profile.
      accountIds: [...accountIds],
      modules: { ...NO_MODULES },
      folders,
      // "New session" starts in the first folder, as Workhub 1 did.
      ...(folders[0] ? { defaultFolder: folders[0] } : {})
    }
    // Workhub 1's folder switches: "Only git repos" and "Each subfolder is its own project".
    const folderOptions: Record<string, FolderOptions> = {}
    for (const f of p.folders ?? []) {
      const path = f.path?.trim()
      if (!path || (!f.onlyGitRepos && !f.isContainer)) continue
      folderOptions[normalizedDir(expandHome(path, home))] = { ...(f.onlyGitRepos ? { onlyGitRepos: true } : {}), ...(f.isContainer ? { subfoldersAreProjects: true } : {}) }
    }
    if (Object.keys(folderOptions).length) profile.folderOptions = folderOptions
    // Only one profile owns the folders outside every profile.
    if (p.catchesOtherFolders && !current.profiles.some((o) => o.ownsOutside) && ![...newProfiles.values()].some((o) => o.ownsOutside)) profile.ownsOutside = true
    // Workhub 1 writes `#RRGGBB` (its parser also takes the digits alone).
    const color = p.color?.trim().replace(/^#/, '')
    if (color && /^[0-9a-fA-F]{6}$/.test(color)) profile.color = `#${color.toLowerCase()}`
    Object.assign(profile, importedLinkOpener(p.linkOpener))
    // Workhub 1 wrote its prompts in one language; Workhub 2's AI review is the prompt with a language.
    if (usesSpanish) profile.aiReview = { ...DEFAULT_AI_REVIEW_SETTINGS, language: 'es' }
    if (p.sessionEnvironment?.some((v) => v.name)) note('notSupported', `profiles.${id}`, 'sessionEnvironment')

    const scope = p.githubScope?.trim()
    if (scope) {
      const cid = slugId(`github-${id}`, 'github')
      if (claim('connections', cid)) {
        plan.connections.push({ id: cid, kind: 'codeHost', provider: 'github', name: `GitHub (${profile.name})`, settings: { scope } })
        // GitHub reads through the `gh` login, so there is no token to enter again.
        if (findProvider('github')?.requiresSecret) note('reenterSecret', `connections.${cid}`)
        profile.connections.codeHost = cid
      }
    }
    const jira = p.id ? v1.jira?.[p.id] : undefined
    if (jira?.site?.trim()) {
      const cid = slugId(`jira-${id}`, 'jira')
      if (claim('connections', cid)) {
        const settings: Record<string, string> = {}
        const keys = (p.ticketPrefixes ?? []).map((k) => k.trim().toUpperCase()).filter(Boolean)
        if (keys.length) settings['projectKeys'] = keys.join(',')
        const ignored = (jira.ignoredStatuses ?? []).map((s) => s.trim()).filter(Boolean)
        if (ignored.length) settings['ignoredStatuses'] = ignored.join(',')
        plan.connections.push({ id: cid, kind: 'tracker', provider: 'jira', name: `Jira (${profile.name})`, endpoint: siteUrl(jira.site), settings })
        note('reenterSecret', `connections.${cid}`)
        profile.connections.tracker = cid
      }
    }
    const obs = p.id ? v1.observability?.[p.id] : undefined
    if (obs?.elasticURL?.trim()) {
      const cid = slugId(`elastic-${id}`, 'elastic')
      if (claim('connections', cid)) {
        plan.connections.push({ id: cid, kind: 'health', provider: 'elastic-apm', name: `Elastic (${profile.name})`, endpoint: obs.elasticURL.trim().replace(/\/+$/, ''), settings: healthConnectionSettings(obs) })
        note('reenterSecret', `connections.${cid}`)
        profile.connections.health = cid
        profile.health = {
          // Workhub 1 refreshed every 5 minutes unless changed; Workhub 2 allows 5 to 60.
          refreshMinutes: clamp(num(v1.healthRefreshMinutes, 5), MIN_HEALTH_REFRESH_MINUTES, MAX_HEALTH_REFRESH_MINUTES),
          environments: healthEnvironments(obs)
        }
        profile.modules.health = true
      }
    }
    plan.profiles.push(profile)
    newProfiles.set(id, profile)
  }
  const anyProfile = plan.profiles[0]?.id ?? current.profiles[0]?.id ?? null
  const slackProfile = v1.slack?.profileID ? (profileId.get(v1.slack.profileID) ?? null) : null
  const turnOn = (id: string | null, module: (typeof OPTIONAL_MODULES)[number]) => {
    const p = id ? newProfiles.get(id) : undefined
    if (p) p.modules[module] = true
  }

  // Slack watcher: one for the whole app in Workhub 2, shown in the profiles that have its module on.
  const slack = v1.slack
  if (slack && (slack.enabled || slack.channels?.length)) {
    if (current.chatWatcher) note('exists', 'chatWatcher')
    else {
      plan.chatWatcher = {
        enabled: slack.enabled === true,
        accountId: accountFor(slack.useSecondAccount) ?? null,
        model: slack.model?.trim() || 'haiku',
        intervalMinutes: Math.max(MIN_WATCH_INTERVAL_MINUTES, Math.round(num(slack.intervalMinutes, 10))),
        startHour: hour(slack.startHour, 9),
        endHour: hour(slack.endHour, 19),
        weekdays: jsWeekdays(slack.weekdays, [1, 2, 3, 4, 5]),
        usageThreshold: clamp(num(slack.usageThreshold, 85), 0, 100),
        channels: (slack.channels ?? []).filter((c) => c.id?.trim()).map((c) => ({ id: c.id!.trim(), name: c.name?.trim() ?? '', purpose: c.purpose?.trim() ?? '' }))
      }
    }
    if (slackProfile) turnOn(slackProfile, 'chatWatcher')
    else for (const p of plan.profiles) p.modules.chatWatcher = true
  }
  const openThreads = (v1.slackThreads ?? []).filter((t) => !t.closed).length
  // Followed threads live in the watcher's data folder with their owner sessions; new ones are followed as sessions post.
  if (openThreads) note('notSupported', 'chatWatcher', 'slack.threads')

  // Automations: each one runs in a profile (Workhub 1's had none): the one whose folder holds it, else Slack's.
  for (const a of v1.automations ?? []) {
    const id = (a.id ?? '').trim().toLowerCase()
    if (!id || !claim('automations', id)) continue
    const folder = a.folder?.trim() || '~'
    const expanded = normalizedDir(expandHome(folder, home))
    const byFolder = profileFolders.filter((f) => isUnder(expanded, f.folder)).sort((x, y) => y.folder.length - x.folder.length)[0]?.id
    const owner = byFolder ?? slackProfile ?? anyProfile
    const gate = a.triggers?.pendingGate
    const pendingGate: PendingGate | undefined = gate && gate.kind === 'slackPRReview' && gate.stateFile?.trim() ? { kind: 'prReviewQueue', stateFile: gate.stateFile.trim() } : undefined
    const interval = a.triggers?.intervalMinutes
    const automation: AutomationDefinition = {
      id,
      name: a.name?.trim() || 'Automation',
      enabled: a.enabled !== false,
      prompt: a.prompt ?? '',
      profileId: owner,
      agentKey: keyOf(accountFor(a.useSecondAccount)),
      folder,
      view: a.viewMode === 'console' ? 'console' : 'app',
      triggers: {
        chatChannelIds: (a.triggers?.slackChannelIds ?? []).map((c) => c.trim()).filter(Boolean),
        prOwner: a.triggers?.prOwner?.trim() ?? '',
        intervalMinutes: typeof interval === 'number' && interval >= 1 ? Math.round(interval) : null,
        ...(pendingGate ? { pendingGate } : {})
      },
      window: { days: jsWeekdays(a.window?.days, [1, 2, 3, 4, 5]), startHour: hour(a.window?.startHour, 9), endHour: hour(a.window?.endHour, 19) },
      limits: {
        maxRuns: Math.max(1, Math.round(num(a.limits?.maxRuns, 6))),
        perMinutes: Math.max(1, Math.round(num(a.limits?.perMinutes, 5))),
        maxPerDay: a.limits?.maxPerDay === null ? null : Math.max(1, Math.round(num(a.limits?.maxPerDay, 60)))
      },
      usageThreshold: clamp(num(a.usageThreshold, 85), 0, 100),
      sessionPolicy: a.sessionPolicy === 'newEachRun' ? 'newEachRun' : 'reuse',
      runTimeoutMinutes: Math.max(1, Math.round(num(a.runTimeoutMinutes, 30))),
      receivesChatReplies: a.receivesSlackReplies !== false
    }
    if (a.model?.trim()) automation.model = a.model.trim()
    if (a.effort?.trim()) automation.effort = a.effort.trim()
    if (a.permissionMode && a.permissionMode !== 'default') automation.permissionMode = a.permissionMode
    if (gate && !pendingGate) note('notSupported', `automations.${id}`, 'pendingGate')
    plan.automations!.push(automation)
    turnOn(owner, 'automations')
  }

  // App options with a Workhub 2 equivalent.
  const options: Partial<AppOptions> = {}
  const n = v1.notifications ?? {}
  const allOff = n.all === false
  // Workhub 1 always read Claude plan usage (usageChecker was only its fallback).
  if (v1.mainAccount || v1.secondAccount || v1.usageChecker?.trim()) options.claudePlanUsage = true
  if (allOff || n.sessionReplies === false) options.notifyReplied = false
  if (allOff || n.sessionWaiting === false) options.notifyNeedsAnswer = false
  if (allOff) options.notifyError = false
  if (allOff || n.pullRequests === false) options.notifyPrEvents = Object.fromEntries(PR_EVENT_KINDS.map((k) => [k, false])) as PrEventToggles
  if (allOff || n.slack === false) options.notifySlack = false
  if (allOff || n.tickets === false) options.notifyTickets = false
  if (allOff || n.automations === false) options.notifyAutomations = false
  // Workhub 1 keeps Health alerts under their own key (`settings.healthAlerts`), not the category.
  if (allOff || v1.healthAlerts === false) options.notifyHealth = false
  // Only a list the user changed from Workhub 1's default is worth carrying over.
  if (v1.protectedBranches !== undefined) {
    const list = [...new Set(v1.protectedBranches.split(/[,\s]+/).filter(Boolean).map((b) => b.toLowerCase()))]
    const isDefault = list.length === DEFAULT_PROTECTED_BRANCHES.length && DEFAULT_PROTECTED_BRANCHES.every((b) => list.includes(b))
    if (list.length && !isDefault) options.protectedBranches = list
  }
  if (Object.keys(options).length) {
    if (current.options) note('exists', 'options')
    else plan.options = options
  }
  if (v1.usageChecker?.trim()) note('notSupported', 'settings', 'usageChecker')
  if (v1.usageRefreshMinutes !== undefined) note('notSupported', 'settings', 'usageRefreshMinutes')
  if (v1.prBabysitter === true) note('notSupported', 'settings', 'prBabysitter')
  // Renderer preferences: the model per account, the interface language and the appearance.
  const prefs: ImportPrefs = {}
  for (const [folderName, model] of Object.entries(v1.sessionModels ?? {})) {
    const accountId = accountByFolderName.get(folderName)
    if (accountId && model.trim()) prefs.models = { ...prefs.models, [keyOf(accountId)]: model.trim() }
  }
  for (const [folderName, effort] of Object.entries(v1.sessionEfforts ?? {})) {
    const accountId = accountByFolderName.get(folderName)
    if (accountId && effort.trim()) note('notSupported', `accounts.${accountId}`, 'effort')
  }
  const lang = v1.appLanguage?.toLowerCase() ?? ''
  if (lang.startsWith('es')) prefs.language = 'es'
  else if (lang.startsWith('en')) prefs.language = 'en'
  const appearance = appearanceFrom(v1.appearance)
  if (appearance) prefs.appearance = appearance
  if (prefs.models || prefs.language || prefs.appearance) plan.prefs = prefs

  // Sidebar groups and order. A Claude session's id is its agent session id in both apps.
  const groups = sessionGroupsFrom(v1.openSessions, (kind) => (kind === 'claude' ? keyOf(accountRef.main) : kind === 'claudeSecond' && accountRef.second ? keyOf(accountRef.second) : null))
  const stored = current.sessionGroups ?? EMPTY_SESSION_GROUPS
  const merged = mergeSessionGroups(stored, groups)
  if (merged.groups.length !== stored.groups.length || merged.top.length !== stored.top.length) plan.sessionGroups = groups

  const selected = v1.sidebarProfile ? profileId.get(v1.sidebarProfile) : undefined
  if (!current.activeProfileId && selected && (newProfiles.has(selected) || current.profiles.some((p) => p.id === selected))) plan.activeProfileId = selected
  return plan
}

/** Workhub 1's open sessions as Workhub 2 session groups; sessions without a Workhub 2 agent (shells, a missing account) are left out. */
export function sessionGroupsFrom(saved: Workhub1OpenSessions | undefined, agentKeyOf: (kind: string) => string | null): SessionGroups {
  if (!saved) return EMPTY_SESSION_GROUPS
  const members = new Map<string, { member: GroupMember; group: string | null }>()
  for (const s of saved.sessions ?? []) {
    const key = s.sessionID?.trim().toLowerCase()
    const agentKey = s.kind ? agentKeyOf(s.kind) : null
    if (!key || !agentKey || members.has(key)) continue
    const cwd = normalizedDir(s.folder?.trim() ?? '')
    members.set(key, { member: { key, title: s.name?.trim() || basename(cwd) || key, agentKey, cwd }, group: s.group?.trim().toLowerCase() || null })
  }
  const groups: SessionGroup[] = (saved.groups ?? [])
    .filter((g) => g.id?.trim())
    .map((g) => {
      const id = g.id!.trim().toLowerCase()
      return { id, name: g.name?.trim() || 'Group', collapsed: g.collapsed === true, members: [...members.values()].filter((m) => m.group === id).map((m) => m.member) }
    })
  const groupIds = new Set(groups.map((g) => g.id))
  const top: TopSlot[] = []
  const placed = new Set<string>()
  const place = (slot: TopSlot) => {
    const k = slot.kind === 'group' ? `g:${slot.id}` : `s:${slot.key}`
    if (placed.has(k)) return
    placed.add(k)
    top.push(slot)
  }
  for (const raw of saved.top ?? []) {
    const id = raw.trim().toLowerCase()
    if (groupIds.has(id)) place({ kind: 'group', id })
    else if (members.has(id) && !groupIds.has(members.get(id)!.group ?? '')) place({ kind: 'session', key: id })
  }
  // Anything the saved order missed goes at the end.
  for (const g of groups) place({ kind: 'group', id: g.id })
  for (const [key, m] of members) if (!groupIds.has(m.group ?? '')) place({ kind: 'session', key })
  return { groups, top }
}

/** Adds groups and sessions the stored groups do not have yet; what is already there wins. */
export function mergeSessionGroups(current: SessionGroups, imported: SessionGroups): SessionGroups {
  const groupIds = new Set(current.groups.map((g) => g.id))
  const placed = new Set([...current.groups.flatMap((g) => g.members.map((m) => m.key)), ...current.top.flatMap((s) => (s.kind === 'session' ? [s.key] : []))])
  const groups = [...current.groups]
  const top = [...current.top]
  for (const g of imported.groups) {
    if (groupIds.has(g.id)) continue
    const members = g.members.filter((m) => !placed.has(m.key))
    for (const m of members) placed.add(m.key)
    groups.push({ ...g, members })
    groupIds.add(g.id)
  }
  const newGroups = new Set(imported.groups.filter((g) => !current.groups.some((c) => c.id === g.id)).map((g) => g.id))
  for (const slot of imported.top) {
    if (slot.kind === 'group' ? newGroups.has(slot.id) && !top.some((s) => s.kind === 'group' && s.id === slot.id) : !placed.has(slot.key)) {
      top.push(slot)
      if (slot.kind === 'session') placed.add(slot.key)
    }
  }
  return { groups, top }
}

/** True when the plan changes nothing: every item already exists or nothing was found. */
export function isEmptyImportPlan(plan: ImportPlan): boolean {
  return (
    plan.profiles.length === 0 &&
    plan.accounts.length === 0 &&
    plan.connections.length === 0 &&
    !plan.automations?.length &&
    !plan.chatWatcher &&
    !plan.options &&
    !plan.sessionGroups?.groups.length &&
    !plan.sessionGroups?.top.length &&
    !plan.activeProfileId
  )
}

/**
 * Applies an import plan to a config, pure: the next config (validated, except that imported
 * connections may lack their secret) and the notes of what was left out. Idempotent: items whose
 * id exists and sections already set up are left as they are, so applying twice adds nothing.
 */
export function applyWorkhub1Import(current: WorkhubConfig, plan: ImportPlan): { result: Result<WorkhubConfig>; notes: ImportNote[] } {
  const notes = [...plan.notes]
  const fresh = <T extends { id: string }>(list: string, have: { id: string }[], items: T[]): T[] =>
    items.filter((item) => {
      const known = have.some((x) => x.id === item.id)
      if (known && !notes.some((n) => n.code === 'exists' && n.path === `${list}.${item.id}`)) notes.push({ code: 'exists', path: `${list}.${item.id}` })
      return !known
    })
  const accounts = fresh('accounts', current.accounts, plan.accounts)
  const connections = fresh('connections', current.connections, plan.connections)
  const profiles = fresh('profiles', current.profiles, plan.profiles)
  const next: WorkhubConfig = {
    ...current,
    accounts: [...current.accounts, ...accounts],
    connections: [...current.connections, ...connections],
    profiles: [...current.profiles, ...profiles]
  }
  const profileIds = new Set(next.profiles.map((p) => p.id))
  const automations = fresh('automations', current.automations ?? [], plan.automations ?? []).map((a) => (a.profileId && !profileIds.has(a.profileId) ? { ...a, profileId: null } : a))
  if (automations.length) next.automations = [...(current.automations ?? []), ...automations]
  if (plan.chatWatcher) {
    if (current.chatWatcher) {
      if (!notes.some((n) => n.code === 'exists' && n.path === 'chatWatcher')) notes.push({ code: 'exists', path: 'chatWatcher' })
    } else {
      const accountId = plan.chatWatcher.accountId && next.accounts.some((a) => a.id === plan.chatWatcher!.accountId) ? plan.chatWatcher.accountId : null
      next.chatWatcher = { ...plan.chatWatcher, accountId }
    }
  }
  if (plan.options) {
    if (current.options) {
      if (!notes.some((n) => n.code === 'exists' && n.path === 'options')) notes.push({ code: 'exists', path: 'options' })
    } else next.options = { ...DEFAULT_OPTIONS, ...plan.options }
  }
  if (plan.sessionGroups) {
    const merged = mergeSessionGroups(current.sessionGroups ?? EMPTY_SESSION_GROUPS, plan.sessionGroups)
    if (merged.groups.length !== (current.sessionGroups?.groups.length ?? 0) || merged.top.length !== (current.sessionGroups?.top.length ?? 0)) next.sessionGroups = merged
  }
  if (!next.activeProfileId && plan.activeProfileId && profileIds.has(plan.activeProfileId)) next.activeProfileId = plan.activeProfileId
  if (!next.activeProfileId && next.profiles[0]) next.activeProfileId = next.profiles[0].id
  return { result: commitImported(current, next, connections.map((c) => c.id)), notes }
}
