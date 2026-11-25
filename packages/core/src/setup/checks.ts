/**
 * The setup check (Workhub 1's SetupCheck): what Workhub needs on this machine and the optional
 * integrations, each with a status, one detail and a fix. The functions here are pure; the main
 * process runs the commands and feeds their outcome in. Texts are not here: an item carries a
 * `code` and its `params`, the renderer words them in the user's language.
 */
import type { WorkhubConfig } from '../config/schema'
import { adminOnly, installMethod, installPage, type InstallContext, type InstallerId } from './installers'
import type { SignInTool } from './sign-in'

export type SetupItemId =
  | 'claudeCode'
  | 'claudeSignIn'
  | 'node'
  | 'git'
  | 'github'
  | 'gitlab'
  | 'codex'
  | 'kiro'
  | 'opencode'
  | 'gemini'
  | 'profile'
  | 'linear'
  | 'jira'
  | 'slack'
  | 'health'
  | 'usage'
  | 'agentSkills'
/** `pending`: not checked yet, and not a problem (the WSL host a profile runs on has not connected). */
export type SetupStatus = 'ok' | 'warning' | 'missing' | 'pending'

/**
 * What fixes an item: a Settings tab, a page to read (`admin`: the official install needs
 * administrator rights there), a command to copy, a command Workhub runs from its installer table,
 * one that needs administrator rights, shown to copy with its page, or signing in inside Workhub
 * (`hub.signIn(tool, accountId)`, see sign-in.ts).
 */
export type SetupFix =
  | { kind: 'settings'; tab: string }
  | { kind: 'link'; url: string; title: 'installGuide' | 'downloadNode' | 'installGh' | 'installPage'; admin?: boolean }
  | { kind: 'command'; command: string }
  | { kind: 'install'; installer: InstallerId; command: string; managed?: boolean }
  | { kind: 'adminCommand'; installer: InstallerId; command: string; url: string }
  | { kind: 'signIn'; tool: SignInTool; accountId?: string }

const LINK_TITLES: Partial<Record<InstallerId, 'installGuide' | 'downloadNode' | 'installGh'>> = { claudeCode: 'installGuide', node: 'downloadNode', github: 'installGh' }

/**
 * The fix of a missing tool: Install when Workhub may run the official command here, the command
 * to copy (and its page) when it needs administrator rights, else the official page.
 */
export function installFix(installer: InstallerId, context: InstallContext | string | undefined): SetupFix {
  const platform = typeof context === 'string' ? context : (context?.platform ?? '')
  const method = installMethod(installer, context)
  const url = installPage(installer, platform)
  if (method?.mode === 'run') return { kind: 'install', installer, command: method.command, ...(method.managed ? { managed: true } : {}) }
  if (method?.mode === 'copy') return { kind: 'adminCommand', installer, command: method.command, url }
  return { kind: 'link', url, title: LINK_TITLES[installer] ?? 'installPage', ...(adminOnly(installer, platform) ? { admin: true } : {}) }
}

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

/** A tool's version banner is short: bound what the version patterns scan. */
const banner = (text: string): string => text.slice(0, 256)

export function claudeCodeItem(p: Probe, context?: InstallContext | string): SetupItem {
  const link = installFix('claudeCode', context)
  switch (p.result) {
    case 'ok':
      return item('claudeCode', 'ok', 'version', { version: /\d+\.\d+\.\d+/.exec(banner(p.output))?.[0] ?? firstLine(p.output) })
    case 'notFound':
      return item('claudeCode', 'missing', 'claudeMissing', {}, { fix: link })
    case 'timeout':
      return item('claudeCode', 'warning', 'timeout', { command: 'claude --version' })
    case 'failed':
      return item('claudeCode', 'warning', 'commandFailed', { command: 'claude --version', output: firstLine(p.output) }, { fix: link })
  }
}

/** `claude auth status` of one login. The fix signs in inside Workhub, in that account's config folder (null: the default one). */
export function claudeSignInItem(id: string, name: string, p: Probe, accountId: string | null): SetupItem {
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
  const fix: SetupFix = { kind: 'signIn', tool: 'claude', ...(accountId ? { accountId } : {}) }
  if (!parsed || typeof parsed.loggedIn !== 'boolean') return make('warning', 'authUnreadable', {}, fix)
  if (!parsed.loggedIn) return make('missing', 'notSignedIn', {}, fix)
  const plan = typeof parsed.subscriptionType === 'string' && parsed.subscriptionType ? parsed.subscriptionType : ''
  const who = typeof parsed.email === 'string' && parsed.email ? parsed.email : typeof parsed.authMethod === 'string' ? parsed.authMethod : ''
  return make('ok', 'signedInAs', { who, plan: plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : '' })
}

/**
 * Node.js. Claude sessions, session history and Slack run on Workhub's own runtime; only what
 * `neededBy` names (agents started through `npx` or a Node script) needs one installed.
 */
export function nodeItem(p: Probe, neededBy: readonly string[] = [], context?: InstallContext | string): SetupItem {
  switch (p.result) {
    case 'ok':
      return item('node', 'ok', 'version', { version: /v\d+\.\d+\.\d+/.exec(banner(p.output))?.[0] ?? firstLine(p.output) })
    case 'timeout':
      return item('node', 'warning', 'timeout', { command: 'node --version' })
    default:
      return neededBy.length > 0
        ? item('node', 'missing', 'nodeMissingFor', { names: neededBy.join(', ') }, { fix: installFix('node', context) })
        : item('node', 'missing', 'nodeNotNeeded', {}, { fix: installFix('node', context) })
  }
}

/** `git --version`. macOS without Apple's tools answers through a stub that fails: that is missing too. */
export function gitItem(p: Probe, context?: InstallContext | string): SetupItem {
  if (p.result === 'ok') return item('git', 'ok', 'version', { version: /\d+\.\d+(?:\.\d+)?/.exec(banner(p.output))?.[0] ?? firstLine(p.output) })
  if (p.result === 'timeout') return item('git', 'warning', 'timeout', { command: 'git --version' })
  return item('git', 'missing', 'gitMissing', {}, { fix: installFix('git', context) })
}

/**
 * Claude Code, its sign-in and git as found inside the WSL distribution `host` the active profile
 * runs in (`claude --version` of the host's bundled Claude Code, `claude auth status`, `git
 * --version`), or pending while that host has not connected (`probes` null). No row carries a fix:
 * every fix the check knows installs or signs in on this computer.
 */
export function hostToolItems(host: string, probes: { claude: Probe; auth: Probe; git: Probe } | null): SetupItem[] {
  const inHost = (i: SetupItem): SetupItem => {
    const { fix: _fix, ...rest } = i
    return { ...rest, params: { ...i.params, host }, ...(i.kind === 'claudeSignIn' && i.code === 'notSignedIn' ? { code: 'hostNotSignedIn' } : {}) }
  }
  const signInId = `claudeSignIn:wsl:${host}`
  if (!probes) return [item('claudeCode', 'pending', 'hostPending', { host }), { ...item('claudeSignIn', 'pending', 'hostPending', { host, name: 'Claude' }), id: signInId }, item('git', 'pending', 'hostPending', { host })]
  return [inHost(claudeCodeItem(probes.claude)), inHost(claudeSignInItem(signInId, 'Claude', probes.auth, null)), inHost(gitItem(probes.git))]
}

/**
 * Installed, then signed in. `version` is `gh --version`, `user` is `gh api user --jq .login`
 * (needs the network) and `token` is `gh auth token` (local), which tells a missing login from GitHub not answering.
 */
export function githubItem(version: Probe, user: Probe | null, token: Probe | null, context?: InstallContext | string): SetupItem {
  if (version.result === 'notFound') return item('github', 'missing', 'ghMissing', {}, { fix: installFix('github', context) })
  if (version.result === 'timeout') return item('github', 'warning', 'timeout', { command: 'gh --version' })
  const login = user?.result === 'ok' ? user.output.trim() : ''
  if (login) return item('github', 'ok', 'ghSignedIn', { login })
  // A stored token does not mean signed in: gh keeps one in the system keychain after its settings
  // are gone, and a token can be revoked or expired. GitHub (or gh) saying so is "signed out"; only
  // a failure that says nothing of the kind is "GitHub did not answer".
  const refused = user?.result === 'failed' && /gh auth login|HTTP 401|Bad credentials/i.test(user.output)
  if (token?.result === 'ok' && !refused) return item('github', 'warning', 'ghNoAnswer')
  return item('github', 'missing', 'ghNotSignedIn', {}, { fix: { kind: 'signIn', tool: 'github' } })
}

/** Installed (`glab --version`), then signed in (`glab auth status` ends well and names the user). */
export function gitlabItem(version: Probe, auth: Probe | null, context?: InstallContext | string): SetupItem {
  if (version.result === 'notFound') return item('gitlab', 'missing', 'glabMissing', {}, { fix: installFix('gitlab', context) })
  if (version.result === 'timeout') return item('gitlab', 'warning', 'timeout', { command: 'glab --version' })
  // GitLab not answering (a rate limit, say) leaves the sign-in unread: the row still offers it, or a
  // person who is signed out could not sign in from here until GitLab answers again.
  if (auth?.result === 'timeout') return item('gitlab', 'warning', 'timeout', { command: 'glab auth status' }, { fix: { kind: 'signIn', tool: 'gitlab' } })
  if (auth?.result === 'ok') {
    const login = /Logged in to \S+ as (\S+)/i.exec(auth.output)?.[1] ?? ''
    return login ? item('gitlab', 'ok', 'ghSignedIn', { login }) : item('gitlab', 'ok', 'signedIn')
  }
  return item('gitlab', 'missing', 'glabNotSignedIn', {}, { fix: { kind: 'signIn', tool: 'gitlab' } })
}

/**
 * Codex sessions start the ACP adapter with `npx`, which comes with Node.js: the row checks those,
 * not a `codex` command. The first session downloads the adapter. `auth` is `codex login status`
 * when the `codex` command is there: signed out, the row signs in inside Workhub; without the
 * command (null or not found) the sign-in is read from `signedIn`: whether Codex's saved sign-in
 * (or an API key) was found. False: the row asks to install the command, which is what signs in
 * (with Node.js missing too, that one install brings Node.js along, so a person does not install
 * twice); null (not looked at) leaves the row ready.
 */
export function codexItem(npx: Probe, node: Probe, context?: InstallContext | string, auth: Probe | null = null, signedIn: boolean | null = null): SetupItem {
  if (npx.result === 'ok' && node.result === 'ok') {
    if (auth?.result === 'failed') return item('codex', 'missing', 'codexNotSignedIn', {}, { fix: { kind: 'signIn', tool: 'codex' } })
    if (auth?.result !== 'ok' && signedIn === false) return item('codex', 'missing', 'codexNeedsCli', {}, { fix: installFix('codex', context) })
    return item('codex', 'ok', 'codexReady', { version: /v\d+\.\d+\.\d+/.exec(node.output)?.[0] ?? firstLine(node.output) })
  }
  if (npx.result === 'timeout' || node.result === 'timeout') return item('codex', 'warning', 'timeout', { command: npx.result === 'timeout' ? 'npx --version' : 'node --version' })
  // No Node.js, no Codex command and no saved sign-in: where Workhub installs the command itself, it
  // comes with Node.js, and the row then offers the sign-in.
  if (signedIn === false && (auth === null || auth.result === 'notFound') && installMethod('codex', context)?.managed) return item('codex', 'missing', 'codexNeedsCli', {}, { fix: installFix('codex', context) })
  // Workhub installs its own Node.js and fetches the adapter with it where it can; else Node's own fix.
  return item('codex', 'missing', 'codexNeedsNode', {}, { fix: installMethod('codexAdapter', context) ? installFix('codexAdapter', context) : installFix('node', context) })
}

const AGENT_COMMANDS = { kiro: 'kiro-cli', opencode: 'opencode', gemini: 'gemini' } as const

/**
 * An agent with a command of its own: installed (its version) or not. `auth` is Kiro's
 * `kiro-cli whoami` (the only one of these with a sign-in flow): failed means signed out.
 */
export function agentItem(kind: 'kiro' | 'opencode' | 'gemini', p: Probe, context?: InstallContext | string, auth: Probe | null = null): SetupItem {
  if (p.result === 'ok') {
    if (kind === 'kiro' && auth?.result === 'failed') return item(kind, 'missing', 'kiroNotSignedIn', {}, { fix: { kind: 'signIn', tool: 'kiro' } })
    if (kind === 'kiro' && auth?.result === 'timeout') return item(kind, 'warning', 'timeout', { command: 'kiro-cli whoami' })
    return item(kind, 'ok', 'version', { version: /\d+\.\d+(?:\.\d+)?/.exec(banner(p.output))?.[0] ?? firstLine(p.output) })
  }
  if (p.result === 'timeout') return item(kind, 'warning', 'timeout', { command: `${AGENT_COMMANDS[kind]} --version` })
  return item(kind, 'missing', `${kind}Missing`, {}, { fix: installFix(kind, context) })
}

export function profileItem(config: Pick<WorkhubConfig, 'profiles'>): SetupItem {
  const withFolders = config.profiles.filter((p) => (p.folders?.length ?? 0) > 0)
  if (withFolders.length === 0) return item('profile', 'missing', 'noFolders', {}, { fix: { kind: 'settings', tab: 'profiles' } })
  const folders = withFolders.reduce((n, p) => n + (p.folders?.length ?? 0), 0)
  return item('profile', 'ok', 'profileFolders', { names: withFolders.map((p) => p.name).join(', '), count: String(folders) })
}

/** A Linear tracker connection with its API key: a connection check, nothing to install. */
export function linearItem(config: Pick<WorkhubConfig, 'profiles' | 'connections'>, hasSecret: (ref: string) => boolean): SetupItem {
  const linear = config.connections.filter((c) => c.kind === 'tracker' && c.provider === 'linear')
  const fix: SetupFix = { kind: 'settings', tab: 'trackers' }
  const ready = linear.filter((c) => c.secretRef && hasSecret(c.secretRef))
  if (ready.length > 0) {
    const names = ready.flatMap((c) => config.profiles.filter((p) => p.connections.tracker === c.id).map((p) => p.name))
    return item('linear', 'ok', 'linearConnected', { names: (names.length ? names : ready.map((c) => c.name || c.id)).join(', ') }, { optional: true })
  }
  if (linear[0]) return item('linear', 'warning', 'linearNoKey', { name: linear[0].name || linear[0].id }, { optional: true, fix })
  return item('linear', 'missing', 'linearOff', {}, { optional: true, fix })
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
/**
 * Workhub's skills in the Claude Code folders (Settings → Agents → Workhub tools): optional, since
 * sessions get Workhub's MCP server anyway. `installed` and `total` count folders.
 */
export function agentSkillsItem(folders: { installed: number; outdated: number; total: number }): SetupItem {
  const fix: SetupFix = { kind: 'settings', tab: 'accounts' }
  if (folders.total === 0) return item('agentSkills', 'missing', 'skillsNoClaude', {}, { optional: true })
  if (folders.outdated > 0) return item('agentSkills', 'warning', 'skillsOutdated', { count: String(folders.outdated) }, { optional: true, fix })
  if (folders.installed === folders.total) return item('agentSkills', 'ok', 'skillsInstalled', { count: String(folders.total) }, { optional: true })
  return item('agentSkills', 'missing', 'skillsMissing', {}, { optional: true, fix })
}

export function usageItem(options: { claudePlanUsage: boolean; codexUsage: boolean }): SetupItem {
  const on = [options.claudePlanUsage ? 'Claude' : '', options.codexUsage ? 'Codex' : ''].filter(Boolean)
  if (on.length > 0) return item('usage', 'ok', 'usageOn', { sources: on.join(', ') }, { optional: true })
  return item('usage', 'missing', 'usageOff', {}, { optional: true, fix: { kind: 'settings', tab: 'usage' } })
}

/**
 * The installers "Install what is missing" runs: the needed rows that are not ready and that
 * Workhub can install here (an Install fix), in the rows' order (`installQueue` sorts them).
 */
export function missingInstallers(items: readonly SetupItem[]): InstallerId[] {
  const ids = items.flatMap((i) => (!i.optional && i.status !== 'ok' && i.fix?.kind === 'install' ? [i.fix.installer] : []))
  return [...new Set(ids)]
}
