import { shell } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { chromeDataDirName, parseChromeProfiles, type ChromeProfile, type LinkCommand } from '@workhub/core'
import { slackTeamIdFromState, type LinkDeps } from './link-service'

const SLACK_APPS = ['/Applications/Slack.app', join(homedir(), 'Applications', 'Slack.app')]
/** Where the Slack desktop app keeps the workspaces it is signed in to (read only, and only when a Slack link is opened). */
const SLACK_STATE = [
  join(homedir(), 'Library/Containers/com.tinyspeck.slackmacgap/Data/Library/Application Support/Slack/storage/root-state.json'),
  join(homedir(), 'Library/Application Support/Slack/storage/root-state.json')
]
const CHROME_SUPPORT = join(homedir(), 'Library/Application Support/Google')

/** The real system behind the link service. */
/** `path` is the login shell's PATH (read once at start-up), so a custom command resolves as it does in a terminal. */
export function systemLinkDeps(config: LinkDeps['config'], path: () => string | undefined): LinkDeps {
  return {
    platform: process.platform,
    config,
    openDefault: (url) => shell.openExternal(url),
    run: ({ command, args }: LinkCommand) => new Promise<boolean>((done) => execFile(command, args, { windowsHide: true, env: { ...process.env, PATH: path() ?? process.env['PATH'] } }, (err) => done(!err))),
    slack: {
      installed: () => SLACK_APPS.some((app) => existsSync(app)),
      teamId: async (host) => {
        for (const file of SLACK_STATE) {
          const team = await readFile(file, 'utf8').then((text) => slackTeamIdFromState(text, host), () => undefined)
          if (team) return team
        }
        return undefined
      }
    }
  }
}

/**
 * Chrome's profiles, from the `Local State` file of the Chrome app's data folder (read only,
 * nothing else in it): Google's own, or a separate copy's `~/Library/Application Support/Google/<app name>`.
 * Empty off macOS, without that Chrome, or when the folder is not where the name suggests.
 */
export async function listChromeProfiles(app?: string): Promise<ChromeProfile[]> {
  const folder = chromeDataDirName(app)
  if (process.platform !== 'darwin' || !folder) return []
  return readFile(join(CHROME_SUPPORT, folder, 'Local State'), 'utf8').then(parseChromeProfiles, () => [])
}
