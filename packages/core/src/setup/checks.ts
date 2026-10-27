/**
 * The setup check (Workhub 1's SetupCheck): what Workhub needs on this machine and the optional
 * integrations, each with a status, one detail and a fix. The functions here are pure; the main
 * process runs the commands and feeds their outcome in. Texts are not here: an item carries a
 * `code` and its `params`, the renderer words them in the user's language.
 */
import type { WorkhubConfig } from '../config/schema'

export type SetupItemId = 'claudeCode' | 'claudeSignIn' | 'node' | 'github' | 'codex' | 'kiro' | 'profile' | 'jira' | 'slack' | 'health' | 'usage'
export type SetupStatus = 'ok' | 'warning' | 'missing'

/** What fixes an item: a Settings tab, a page to read, or a command to run in a terminal. */
export type SetupFix = { kind: 'settings'; tab: string } | { kind: 'link'; url: string; title: 'installGuide' | 'downloadNode' | 'installGh' } | { kind: 'command'; command: string }

export interface SetupItem {
  /** `claudeSignIn:<accountKey>` for one row per Claude login. */
  id: string
  kind: SetupItemId
  status: SetupStatus
  /** What was found or what to do, as a message code the renderer words. */
  code: string
  params: Record<string, string>
  fix?: SetupFix
  /** Workhub works without it: missing reads as optional, not as a problem. */
  optional: boolean
}

export const CLAUDE_CODE_SETUP_URL = 'https://docs.claude.com/en/docs/claude-code/setup'
export const NODE_DOWNLOAD_URL = 'https://nodejs.org/en/download'
export const GH_INSTALL_URL = 'https://cli.github.com/'

/** The result of running one command: how it ended and what it printed. */
export type Probe = { result: 'ok' | 'failed' | 'notFound' | 'timeout'; output: string }

export const needsAttention = (i: Pick<SetupItem, 'status'>): boolean => i.status === 'missing' || i.status === 'warning'

/** Requirements that are missing or need a look (optional rows never count). */
export const problemCount = (items: readonly SetupItem[]): number => items.filter((i) => !i.optional && needsAttention(i)).length

const item = (kind: SetupItemId, status: SetupStatus, code: string, params: Record<string, string> = {}, extra: Partial<SetupItem> = {}): SetupItem => ({
  id: kind,
  kind,
  status,
  code,
  params,
  optional: false,
  ...extra
})

const firstLine = (text: string): string => text.split(/\r?\n/).find((l) => l.trim())?.trim() ?? ''

export function claudeCodeItem(p: Probe): SetupItem {
  const link: SetupFix = { kind: 'link', url: CLAUDE_CODE_SETUP_URL, title: 'installGuide' }
  switch (p.result) {
    case 'ok':
      return item('claudeCode', 'ok', 'version', { version: /\d+\.\d+\.\d+/.exec(p.output)?.[0] ?? firstLine(p.output) })
    case 'notFound':
      return item('claudeCode', 'missing', 'claudeMissing', {}, { fix: link })
    case 'timeout':
      return item('claudeCode', 'warning', 'timeout', { command: 'claude --version' })
    case 'failed':
      return item('claudeCode', 'warning', 'commandFailed', { command: 'claude --version', output: firstLine(p.output) }, { fix: link })
  }
}

/** `claude auth status` of one login. `loginCommand` is what the fix copies (it carries CLAUDE_CONFIG_DIR for a non-default folder). */
export function claudeSignInItem(id: string, name: string, p: Probe, loginCommand: string): SetupItem {
  const base = { id, params: { name } }
  const make = (status: SetupStatus, code: string, params: Record<string, string> = {}, fix?: SetupFix): SetupItem => ({
    ...item('claudeSignIn', status, code, { ...base.params, ...params }, fix ? { fix } : {}),
    id
  })
  if (p.result === 'notFound') return make('missing', 'installClaudeFirst')
  if (p.result === 'timeout') return make('warning', 'timeout', { command: 'claude auth status' })
  // Signed out, it may exit non-zero and still print the status.
  let parsed: { loggedIn?: unknown; email?: unknown; authMethod?: unknown; subscriptionType?: unknown } | null = null
  try {
    const value: unknown = JSON.parse(p.output)
    if (value && typeof value === 'object') parsed = value
  } catch {
    parsed = null
  }
  const fix: SetupFix = { kind: 'command', command: loginCommand }
  if (!parsed || typeof parsed.loggedIn !== 'boolean') return make('warning', 'authUnreadable', {}, fix)
  if (!parsed.loggedIn) return make('missing', 'notSignedIn', {}, fix)
  const plan = typeof parsed.subscriptionType === 'string' && parsed.subscriptionType ? parsed.subscriptionType : ''
  const who = typeof parsed.email === 'string' && parsed.email ? parsed.email : typeof parsed.authMethod === 'string' ? parsed.authMethod : ''
  return make('ok', 'signedInAs', { who, plan: plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : '' })
}

/** The Node scripts (session history, Slack) run `node` through the login shell, so one from a version manager counts too. */
export function nodeItem(p: Probe): SetupItem {
  switch (p.result) {
    case 'ok':
      return item('node', 'ok', 'version', { version: /v\d+\.\d+\.\d+/.exec(p.output)?.[0] ?? firstLine(p.output) })
    case 'timeout':
      return item('node', 'warning', 'timeout', { command: 'node --version' })
    default:
      return item('node', 'missing', 'nodeMissing', {}, { fix: { kind: 'link', url: NODE_DOWNLOAD_URL, title: 'downloadNode' } })
  }
}

/**
 * Installed, then signed in. `version` is `gh --version`, `user` is `gh api user --jq .login`
 * (needs the network) and `token` is `gh auth token` (local), which tells a missing login from GitHub not answering.
 */
export function githubItem(version: Probe, user: Probe | null, token: Probe | null): SetupItem {
  if (version.result === 'notFound') return item('github', 'missing', 'ghMissing', {}, { fix: { kind: 'command', command: 'brew install gh' } })
  if (version.result === 'timeout') return item('github', 'warning', 'timeout', { command: 'gh --version' })
  const login = user?.result === 'ok' ? user.output.trim() : ''
  if (login) return item('github', 'ok', 'ghSignedIn', { login })
  if (token?.result === 'ok') return item('github', 'warning', 'ghNoAnswer')
  return item('github', 'missing', 'ghNotSignedIn', {}, { fix: { kind: 'command', command: 'gh auth login' } })
}

/** Codex and Kiro are optional agents: present or not, never a problem. */
export function agentItem(kind: 'codex' | 'kiro', p: Probe): SetupItem {
  if (p.result === 'ok') return item(kind, 'ok', 'version', { version: /\d+\.\d+(?:\.\d+)?/.exec(p.output)?.[0] ?? firstLine(p.output) }, { optional: true })
  if (p.result === 'timeout') return item(kind, 'warning', 'timeout', { command: kind === 'codex' ? 'codex --version' : 'kiro-cli --version' }, { optional: true })
  return item(kind, 'missing', kind === 'codex' ? 'codexMissing' : 'kiroMissing', {}, { optional: true, fix: { kind: 'settings', tab: 'accounts' } })
}

export function profileItem(config: Pick<WorkhubConfig, 'profiles'>): SetupItem {
  const withFolders = config.profiles.filter((p) => (p.folders?.length ?? 0) > 0)
  if (withFolders.length === 0) return item('profile', 'missing', 'noFolders', {}, { fix: { kind: 'settings', tab: 'profiles' } })
  const folders = withFolders.reduce((n, p) => n + (p.folders?.length ?? 0), 0)
  return item('profile', 'ok', 'profileFolders', { names: withFolders.map((p) => p.name).join(', '), count: String(folders) })
}

export function jiraItem(config: Pick<WorkhubConfig, 'profiles' | 'connections'>, hasSecret: (ref: string) => boolean): SetupItem {
  const jira = config.connections.filter((c) => c.kind === 'tracker' && c.provider === 'jira')
  const owners = (connectionId: string) => config.profiles.filter((p) => p.connections.tracker === connectionId).map((p) => p.name)
  const ready = jira.filter((c) => c.endpoint && c.secretRef && hasSecret(c.secretRef))
  const fix: SetupFix = { kind: 'settings', tab: 'trackers' }
  if (ready.length > 0) {
    const names = ready.flatMap((c) => owners(c.id))
    return item('jira', 'ok', 'jiraConnected', { names: (names.length ? names : ready.map((c) => c.name || c.id)).join(', ') }, { optional: true })
  }
  const incomplete = jira.find((c) => c.endpoint)
  if (incomplete) return item('jira', 'warning', 'jiraNoToken', { name: incomplete.name || incomplete.id }, { optional: true, fix })
  return item('jira', 'missing', 'jiraOff', {}, { optional: true, fix })
}

export function slackItem(config: Pick<WorkhubConfig, 'chatWatcher'>, failing: string | null): SetupItem {
  const fix: SetupFix = { kind: 'settings', tab: 'connections' }
  const watcher = config.chatWatcher
  if (!watcher?.enabled) return item('slack', 'missing', 'slackOff', {}, { optional: true, fix })
  if (failing !== null) return item('slack', 'warning', 'slackFailing', { error: failing }, { optional: true, fix })
  return item('slack', 'ok', 'slackOn', { count: String(watcher.channels.length) }, { optional: true })
}

export function healthItem(config: Pick<WorkhubConfig, 'profiles'>): SetupItem {
  const fix: SetupFix = { kind: 'settings', tab: 'health' }
  const configured = config.profiles.filter((p) => (p.health?.environments.length ?? 0) > 0 && p.connections.health)
  if (configured.length > 0) return item('health', 'ok', 'healthConfigured', { names: configured.map((p) => p.name).join(', ') }, { optional: true })
  const partial = config.profiles.find((p) => p.connections.health || (p.health?.environments.length ?? 0) > 0)
  if (partial) return item('health', 'warning', 'healthIncomplete', { name: partial.name }, { optional: true, fix })
  return item('health', 'missing', 'healthOff', {}, { optional: true, fix })
}

/** Where plan usage comes from: Claude's usage endpoint and Codex's, both opt-in; without them only local token counts show. */
export function usageItem(options: { claudePlanUsage: boolean; codexUsage: boolean }): SetupItem {
  const on = [options.claudePlanUsage ? 'Claude' : '', options.codexUsage ? 'Codex' : ''].filter(Boolean)
  if (on.length > 0) return item('usage', 'ok', 'usageOn', { sources: on.join(', ') }, { optional: true })
  return item('usage', 'missing', 'usageOff', {}, { optional: true, fix: { kind: 'settings', tab: 'usage' } })
}
