import type { AgentAccount } from '../domain/agent'
import type { Connection } from '../domain/connection'
import { NO_MODULES, type Profile } from '../domain/profile'
import type { WorkhubConfig } from '../config/schema'

/**
 * Workhub 1's settings, as its UserDefaults hold them (each value is JSON Workhub 1 encoded).
 * Only the parts Workhub 2 maps are typed; anything else is ignored.
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
}

export interface Workhub1Account {
  name?: string
  configDirectory?: string
  /** A wrapper command that starts the account in a terminal. */
  command?: string
}

export interface Workhub1Profile {
  id?: string
  name?: string
  folders?: { path?: string }[]
  githubScope?: string
  ticketPrefixes?: string[]
  sessionEnvironment?: { name?: string; value?: string }[]
}

export interface Workhub1Jira {
  site?: string
  keychainService?: string
  ignoredStatuses?: string[]
}

export type ImportNoteCode =
  /** A Workhub 2 item with the same id exists; the imported one is left out. */
  | 'exists'
  /** A secret (token) lives in Workhub 1's Keychain item; it is not copied and must be entered again. */
  | 'reenterSecret'
  /** The Workhub 1 setting has no Workhub 2 equivalent yet. */
  | 'notSupported'

export interface ImportNote {
  code: ImportNoteCode
  /** `profiles`, `accounts` or `connections`, and the id. */
  path: string
  /** What was left out, e.g. `command` or `sessionEnvironment`. */
  detail?: string
}

export interface ImportPlan {
  profiles: Profile[]
  accounts: AgentAccount[]
  connections: Connection[]
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

function siteUrl(site: string): string {
  const trimmed = site.trim().replace(/\/+$/, '')
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

/**
 * Maps Workhub 1's settings onto Workhub 2's config, without touching either: profiles with their
 * folders, both Claude accounts and each profile's GitHub and Jira connection. Ids that already
 * exist are left out; secrets are never imported (Workhub 1 keeps them in the Keychain).
 */
export function planWorkhub1Import(v1: Workhub1Settings, current: WorkhubConfig, home: string): ImportPlan {
  const plan: ImportPlan = { profiles: [], accounts: [], connections: [], notes: [] }
  const taken = {
    profiles: new Set(current.profiles.map((p) => p.id)),
    accounts: new Set(current.accounts.map((a) => a.id)),
    connections: new Set(current.connections.map((c) => c.id))
  }
  const claim = (list: keyof typeof taken, id: string): boolean => {
    if (taken[list].has(id)) {
      plan.notes.push({ code: 'exists', path: `${list}.${id}` })
      return false
    }
    taken[list].add(id)
    return true
  }

  const defaultDir = normalizedDir(expandHome('~/.claude', home))
  const accountIds: string[] = []
  for (const [fallbackName, v1Account] of [
    ['Claude', v1.mainAccount],
    ['Claude 2', v1.secondAccount]
  ] as const) {
    if (!v1Account) continue
    const name = (v1Account.name ?? '').split(/\s+/).filter(Boolean).join(' ') || fallbackName
    const id = slugId(`claude-${name}`, 'claude-account')
    const dir = normalizedDir(expandHome(v1Account.configDirectory?.trim() || '~/.claude', home))
    const account: AgentAccount = { id, agentId: 'claude', name }
    // The default folder runs without CLAUDE_CONFIG_DIR, as in Workhub 1.
    if (dir !== defaultDir) account.configDir = dir
    if (v1Account.command?.trim()) plan.notes.push({ code: 'notSupported', path: `accounts.${id}`, detail: 'command' })
    if (!claim('accounts', id)) continue
    plan.accounts.push(account)
    accountIds.push(id)
  }

  for (const [index, p] of (v1.profiles ?? []).entries()) {
    const id = slugId(p.id ?? p.name ?? '', `profile-${index + 1}`)
    // A profile left out takes its connections with it.
    if (!claim('profiles', id)) continue
    const profile: Profile = {
      id,
      name: p.name?.trim() || id,
      connections: {},
      // Workhub 1's accounts serve every profile.
      accountIds: [...accountIds],
      modules: { ...NO_MODULES },
      folders: (p.folders ?? []).map((f) => f.path?.trim()).filter((x): x is string => !!x).map((x) => normalizedDir(expandHome(x, home)))
    }
    if (p.sessionEnvironment?.some((v) => v.name)) plan.notes.push({ code: 'notSupported', path: `profiles.${id}`, detail: 'sessionEnvironment' })

    const scope = p.githubScope?.trim()
    if (scope) {
      const cid = slugId(`github-${id}`, 'github')
      if (claim('connections', cid)) {
        plan.connections.push({ id: cid, kind: 'codeHost', provider: 'github', name: `GitHub (${profile.name})`, settings: { scope } })
        plan.notes.push({ code: 'reenterSecret', path: `connections.${cid}` })
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
        plan.notes.push({ code: 'reenterSecret', path: `connections.${cid}` })
        profile.connections.tracker = cid
      }
    }
    plan.profiles.push(profile)
  }
  return plan
}
