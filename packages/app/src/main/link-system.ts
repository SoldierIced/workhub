import { shell } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseChromeProfiles, type ChromeProfile, type LinkCommand } from '@workhub/core'
import { slackTeamIdFromState, type LinkDeps } from './link-service'

const SLACK_APPS = ['/Applications/Slack.app', join(homedir(), 'Applications', 'Slack.app')]
/** Where the Slack desktop app keeps the workspaces it is signed in to (read only, and only when a Slack link is opened). */
const SLACK_STATE = [
  join(homedir(), 'Library/Containers/com.tinyspeck.slackmacgap/Data/Library/Application Support/Slack/storage/root-state.json'),
  join(homedir(), 'Library/Application Support/Slack/storage/root-state.json')
]
const CHROME_LOCAL_STATE = join(homedir(), 'Library/Application Support/Google/Chrome/Local State')

/** The real system behind the link service. */
export function systemLinkDeps(config: LinkDeps['config']): LinkDeps {
  return {
    platform: process.platform,
    config,
    openDefault: (url) => shell.openExternal(url),
    run: ({ command, args }: LinkCommand) => new Promise<boolean>((done) => execFile(command, args, { windowsHide: true }, (err) => done(!err))),
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

/** Chrome's profiles, from its `Local State` file (read only, nothing else in Chrome's folder); empty off macOS or without Chrome. */
export async function listChromeProfiles(): Promise<ChromeProfile[]> {
  if (process.platform !== 'darwin') return []
  return readFile(CHROME_LOCAL_STATE, 'utf8').then(parseChromeProfiles, () => [])
}
