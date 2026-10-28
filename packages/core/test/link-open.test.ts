import { describe, expect, it } from 'vitest'
import { classifyUrl, linkLaunch, parseChromeProfiles, parseConfig, profileForLink, slackDeepLink, slackTarget } from '../src'

describe('classifyUrl', () => {
  it('tells Slack, web and other links apart', () => {
    expect(classifyUrl('https://acme.slack.com/archives/C1/p1712345678123456')).toBe('slack')
    expect(classifyUrl('https://app.slack.com/client/T1/C1')).toBe('slack')
    expect(classifyUrl('http://slack.com/help')).toBe('slack')
    expect(classifyUrl('https://example.com/slack.com')).toBe('web')
    expect(classifyUrl('https://notslack.com/x')).toBe('web')
    expect(classifyUrl('file:///etc/passwd')).toBe('invalid')
    expect(classifyUrl('slack://channel?team=T1')).toBe('invalid')
    expect(classifyUrl('javascript:alert(1)')).toBe('invalid')
    expect(classifyUrl('https://')).toBe('invalid')
  })
})

describe('Slack deep links', () => {
  it('builds the link of a message', () => {
    const target = slackTarget('https://acme.slack.com/archives/C0123ABC/p1712345678123456')!
    expect(slackDeepLink(target, 'T999')).toBe('slack://channel?team=T999&id=C0123ABC&message=1712345678.123456')
  })
  it('adds thread_ts for a reply, in the permalink formats Slack uses', () => {
    const reply = slackTarget('https://acme.slack.com/archives/C1/p1712345999000200?thread_ts=1712345678.123456&cid=C1')!
    expect(slackDeepLink(reply, 'T1')).toBe('slack://channel?team=T1&id=C1&message=1712345999.000200&thread_ts=1712345678.123456')
    const root = slackTarget('https://acme.slack.com/archives/C1/p1712345678123456?thread_ts=1712345678.123456')!
    expect(slackDeepLink(root, 'T1')).toBe('slack://channel?team=T1&id=C1&message=1712345678.123456')
  })
  it('takes the team from an app.slack.com client link', () => {
    const target = slackTarget('https://app.slack.com/client/T0ABC/C0DEF')!
    expect(slackDeepLink(target, undefined)).toBe('slack://channel?team=T0ABC&id=C0DEF')
  })
  it('gives nothing without a team id or for a page with no deep link', () => {
    expect(slackDeepLink(slackTarget('https://acme.slack.com/archives/C1/p1712345678123456')!, undefined)).toBeNull()
    expect(slackTarget('https://acme.slack.com/help')).toBeNull()
    expect(slackTarget('https://example.com/archives/C1/p1712345678123456')).toBeNull()
  })
})

describe('parseChromeProfiles', () => {
  const state = JSON.stringify({
    profile: { info_cache: { 'Profile 10': { name: 'Ten' }, 'Profile 2': { name: ' Acme ' }, Default: { name: 'Personal' }, 'Profile 3': {}, '../evil': { name: 'x' } } }
  })
  it('lists directory and display name, Default first', () => {
    expect(parseChromeProfiles(state)).toEqual([
      { dir: 'Default', name: 'Personal' },
      { dir: 'Profile 2', name: 'Acme' },
      { dir: 'Profile 3', name: 'Profile 3' },
      { dir: 'Profile 10', name: 'Ten' }
    ])
  })
  it('gives an empty list for anything unreadable', () => {
    expect(parseChromeProfiles('not json')).toEqual([])
    expect(parseChromeProfiles('{}')).toEqual([])
    expect(parseChromeProfiles('{"profile":{"info_cache":[1]}}')).toEqual([])
    expect(parseChromeProfiles('null')).toEqual([])
  })
})

describe('linkLaunch', () => {
  const url = 'https://x.y/?a=1&b=2'
  it('starts Chrome on a profile directory on macOS', () => {
    expect(linkLaunch('darwin', { chromeProfile: 'Profile 2' }, url)).toEqual({ command: 'open', args: ['-na', 'Google Chrome', '--args', '--profile-directory=Profile 2', url] })
    expect(linkLaunch('darwin', { browser: 'Chrome Work', chromeProfile: 'Default' }, url)).toEqual({ command: 'open', args: ['-na', 'Chrome Work', '--args', '--profile-directory=Default', url] })
  })
  it('opens a browser app with open -a, and an executable elsewhere', () => {
    expect(linkLaunch('darwin', { browser: 'Safari' }, url)).toEqual({ command: 'open', args: ['-a', 'Safari', url] })
    expect(linkLaunch('linux', { browser: 'chromium' }, url)).toEqual({ command: 'chromium', args: [url] })
    expect(linkLaunch('win32', { browser: 'chrome.exe', chromeProfile: 'Default' }, url)).toEqual({ command: 'chrome.exe', args: [url] })
  })
  it('uses the default browser when nothing is set, off macOS a Chrome profile alone, or the link is not web', () => {
    expect(linkLaunch('darwin', {}, url)).toBeNull()
    expect(linkLaunch('darwin', { browser: ' ' }, url)).toBeNull()
    expect(linkLaunch('linux', { chromeProfile: 'Default' }, url)).toBeNull()
    expect(linkLaunch('darwin', { browser: 'Safari' }, 'file:///etc/passwd')).toBeNull()
  })
  it('refuses a profile directory that is not a plain name', () => {
    expect(linkLaunch('darwin', { chromeProfile: '--user-data-dir=/tmp/x' }, url)).toBeNull()
    expect(linkLaunch('darwin', { browser: 'Safari', chromeProfile: '../x' }, url)).toEqual({ command: 'open', args: ['-a', 'Safari', url] })
  })
})

describe('profileForLink', () => {
  const config = parseConfig({
    version: 7,
    activeProfileId: 'home',
    connections: [
      { id: 'jira-work', kind: 'tracker', provider: 'jira', endpoint: 'https://acme.atlassian.net', settings: {} },
      { id: 'gh-work', kind: 'codeHost', provider: 'github', settings: { scope: 'org:Acme repo:me/side' } }
    ],
    profiles: [
      { id: 'home', name: 'Home' },
      { id: 'work', name: 'Work', connections: { tracker: 'jira-work', codeHost: 'gh-work' }, linkChromeProfile: 'Profile 2' }
    ]
  })
  it('routes a Jira or GitHub link to the profile that owns it, else the active one', () => {
    expect(profileForLink(config, 'https://acme.atlassian.net/browse/A-1')?.id).toBe('work')
    expect(profileForLink(config, 'https://github.com/acme/api/pull/3')?.id).toBe('work')
    expect(profileForLink(config, 'https://github.com/other/api/pull/3')?.id).toBe('home')
    expect(profileForLink(config, 'https://example.com')?.id).toBe('home')
  })
  it('honours an explicit profile', () => {
    expect(profileForLink(config, 'https://example.com', 'work')?.id).toBe('work')
  })
})
