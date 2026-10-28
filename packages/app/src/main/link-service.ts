import { classifyUrl, linkLaunch, profileForLink, slackDeepLink, slackTarget, type LinkCommand, type WorkhubConfig } from '@workhub/core'

/** What the link service needs from the system; tests pass fakes so nothing is ever launched. */
export interface LinkDeps {
  platform: string
  config: () => Promise<Pick<WorkhubConfig, 'connections' | 'profiles' | 'activeProfileId'>>
  /** Hands a URL to the system (`shell.openExternal`): the default browser, or an app's own scheme. */
  openDefault: (url: string) => Promise<void>
  /** Runs a command; false when it could not start or exited with an error. */
  run: (command: LinkCommand) => Promise<boolean>
  slack: {
    installed: () => boolean
    /** The team id of a workspace host (`acme.slack.com`), when the desktop app is signed in to it. */
    teamId: (host: string) => Promise<string | undefined>
  }
}

/**
 * The one place that opens an external link. Slack links go to the Slack desktop app when it is
 * installed and the workspace is known; everything else goes to the browser the profile chose
 * (Settings → Profiles → "Open links with"), else the default browser. Only web links pass.
 */
export function createLinkService(deps: LinkDeps): { open: (url: string, profileId?: string | null) => Promise<void> } {
  const openDefault = (url: string) => deps.openDefault(url).catch(() => undefined)

  async function openInSlack(url: string): Promise<boolean> {
    if (deps.platform !== 'darwin' || !deps.slack.installed()) return false
    const target = slackTarget(url)
    if (!target) return false
    const link = slackDeepLink(target, target.team ?? (await deps.slack.teamId(target.host)))
    if (!link) return false
    try {
      await deps.openDefault(link)
      return true
    } catch {
      return false
    }
  }

  return {
    async open(url, profileId) {
      const kind = classifyUrl(url)
      if (kind === 'invalid') return
      if (kind === 'slack' && (await openInSlack(url))) return
      const profile = profileForLink(await deps.config(), url, profileId)
      const command = linkLaunch(deps.platform, { browser: profile?.linkBrowser, chromeProfile: profile?.linkChromeProfile, command: profile?.linkCommand }, url)
      // A browser that cannot be started falls back to the default one.
      if (!command || !(await deps.run(command))) await openDefault(url)
    }
  }
}

/**
 * The team id of a workspace in the Slack desktop app's `root-state.json` (`workspaces` or
 * `teams`: id → info with the `domain`); undefined when the app has not signed in to it.
 */
export function slackTeamIdFromState(state: string, host: string): string | undefined {
  const domain = host.toLowerCase().replace(/\.slack\.com$/, '')
  let parsed: unknown
  try {
    parsed = JSON.parse(state)
  } catch {
    return undefined
  }
  const root = parsed as { workspaces?: unknown; teams?: unknown } | null
  const workspaces = root?.workspaces ?? root?.teams
  if (!workspaces || typeof workspaces !== 'object') return undefined
  for (const [id, info] of Object.entries(workspaces)) {
    const record = info as { domain?: unknown; url?: unknown } | null
    const name = String(record?.domain ?? record?.url ?? '').toLowerCase()
    if (name === domain || name.includes(`//${domain}.slack.com`)) return id
  }
  return undefined
}
