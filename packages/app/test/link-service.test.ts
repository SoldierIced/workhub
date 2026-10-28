import { describe, expect, it } from 'vitest'
import { parseConfig, type LinkCommand } from '@workhub/core'
import { createLinkService, slackTeamIdFromState, type LinkDeps } from '../src/main/link-service'

function setup(over: Partial<LinkDeps> & { profile?: object } = {}) {
  const opened: string[] = []
  const ran: LinkCommand[] = []
  const config = parseConfig({ version: 7, activeProfileId: 'p', profiles: [{ id: 'p', name: 'P', ...over.profile }] })
  const deps: LinkDeps = {
    platform: 'darwin',
    config: async () => config,
    openDefault: async (url) => void opened.push(url),
    run: async (c) => (ran.push(c), true),
    slack: { installed: () => true, teamId: async () => 'T1' },
    ...over
  }
  return { service: createLinkService(deps), opened, ran }
}

const PERMALINK = 'https://acme.slack.com/archives/C1/p1712345678123456'

describe('link service', () => {
  it('opens a Slack permalink in the Slack app', async () => {
    const { service, opened, ran } = setup()
    await service.open(PERMALINK)
    expect(opened).toEqual(['slack://channel?team=T1&id=C1&message=1712345678.123456'])
    expect(ran).toEqual([])
  })
  it('falls back to the profile browser when Slack is missing, the team is unknown or the platform has no deep link', async () => {
    for (const over of [{ slack: { installed: () => false, teamId: async () => 'T1' } }, { slack: { installed: () => true, teamId: async () => undefined } }, { platform: 'linux' }]) {
      const { service, opened, ran } = setup({ ...over, profile: { linkBrowser: 'Safari' } })
      await service.open(PERMALINK)
      expect(opened).toEqual([])
      expect(ran).toHaveLength(1)
    }
  })
  it('falls back to the default browser when the Slack deep link fails', async () => {
    const opened: string[] = []
    const { service } = setup({ openDefault: async (url) => (url.startsWith('slack:') ? Promise.reject(new Error('no handler')) : void opened.push(url)) })
    await service.open(PERMALINK)
    expect(opened).toEqual([PERMALINK])
  })
  it('opens a link in the chosen Chrome profile', async () => {
    const { service, opened, ran } = setup({ profile: { linkChromeProfile: 'Profile 2' } })
    await service.open('https://example.com/')
    expect(ran).toEqual([{ command: 'open', args: ['-na', 'Google Chrome', '--args', '--profile-directory=Profile 2', 'https://example.com/'] }])
    expect(opened).toEqual([])
  })
  it('uses the default browser without a setting, or when the browser cannot start', async () => {
    const plain = setup()
    await plain.service.open('https://example.com/')
    expect(plain.opened).toEqual(['https://example.com/'])
    const broken = setup({ profile: { linkBrowser: 'Nope' }, run: async () => false })
    await broken.service.open('https://example.com/')
    expect(broken.opened).toEqual(['https://example.com/'])
  })
  it('ignores anything that is not a web link', async () => {
    const { service, opened, ran } = setup({ profile: { linkBrowser: 'Safari' } })
    await service.open('file:///etc/passwd')
    await service.open('slack://channel?team=T1')
    expect([opened, ran]).toEqual([[], []])
  })
})

describe('slackTeamIdFromState', () => {
  const state = JSON.stringify({ workspaces: { T1: { domain: 'acme' }, T2: { url: 'https://other.slack.com' } } })
  it('finds the team of a workspace host', () => {
    expect(slackTeamIdFromState(state, 'acme.slack.com')).toBe('T1')
    expect(slackTeamIdFromState(state, 'OTHER.slack.com')).toBe('T2')
    expect(slackTeamIdFromState(JSON.stringify({ teams: { T3: { domain: 'x' } } }), 'x.slack.com')).toBe('T3')
  })
  it('gives nothing for an unknown workspace or unreadable state', () => {
    expect(slackTeamIdFromState(state, 'nope.slack.com')).toBeUndefined()
    expect(slackTeamIdFromState('{', 'acme.slack.com')).toBeUndefined()
    expect(slackTeamIdFromState('{}', 'acme.slack.com')).toBeUndefined()
  })
})
