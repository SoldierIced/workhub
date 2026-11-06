import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CONNECTION_PROVIDERS, emptyConfig, NO_MODULES, type Connection, type Profile, type Result, type SecretChange, type WorkhubConfig } from '@workhub/core'
import type { ConfigSnapshot } from '../src/shared/api'

/**
 * The tests render on the server (no DOM), so the controls are swapped for stand-ins that record
 * their props: a test finds a control by its accessible name or test id and calls its handler.
 */
type Recorded = Record<string, unknown> & { 'aria-label'?: string; 'data-testid'?: string }
const controls: Recorded[] = []
vi.mock('../src/renderer/components/atoms', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/renderer/components/atoms')>()
  const record = (tag: string) =>
    function Recording(props: Recorded & { children?: ReactNode }) {
      controls.push(props)
      return createElement(tag, { 'aria-label': props['aria-label'], 'data-testid': props['data-testid'] }, props.children as ReactNode)
    }
  return { ...actual, Switch: record('button'), Button: record('button'), Input: record('input'), Select: record('select'), Textarea: record('textarea') }
})
// The Slack watcher reads a live store the server render cannot subscribe to; its own tests cover it.
vi.mock('../src/renderer/screens/SlackSettings', () => ({ SlackSettings: () => createElement('div', { 'data-testid': 'slack-watcher-stand-in' }) }))

import { TooltipProvider } from '../src/renderer/components/atoms'
import { ConnectionEditor, ConnectionsSection } from '../src/renderer/screens/settings/ConnectionsSection'
import { CONNECTIONS_INDEX } from '../src/renderer/screens/settings/connections-index'
import { connectionProblem, connectionToSave, connectionUses, groupConnections } from '../src/renderer/screens/settings/connections-model'

const github: Connection = { id: 'acme-github', kind: 'codeHost', provider: 'github', name: 'Acme GitHub', settings: {} }
const gitlab: Connection = { id: 'acme-gitlab', kind: 'codeHost', provider: 'gitlab', name: 'Acme GitLab', endpoint: 'https://git.example.com', settings: {} }
const jira: Connection = { id: 'acme-jira', kind: 'tracker', provider: 'jira', name: 'Acme Jira', endpoint: 'https://acme.example.com', settings: { email: 'dev@example.com', projectKeys: 'WEB' } }
const calendar: Connection = { id: 'work-calendar', kind: 'calendar', provider: 'ics', name: 'Work calendar', settings: {} }
const elastic: Connection = { id: 'elastic', kind: 'health', provider: 'elastic-apm', name: 'Elasticsearch', endpoint: 'https://elastic.example.com:9200', settings: {} }

const profile = (id: string, name: string, over: Partial<Profile> = {}): Profile => ({ id, name, connections: {}, accountIds: [], modules: { ...NO_MODULES }, ...over })
const config = (): WorkhubConfig => ({
  ...emptyConfig(),
  connections: [elastic, github, jira, calendar, gitlab],
  profiles: [
    profile('acme', 'Acme web', { connections: { codeHost: 'acme-github', tracker: 'acme-jira', health: 'elastic' }, planner: { calendarIds: ['work-calendar'] } as Profile['planner'] }),
    profile('side', 'Side project', { connections: { codeHost: 'acme-github' } })
  ]
})
const snapshot = (c = config()): ConfigSnapshot => ({ config: c, issues: [], agents: [], providers: [...CONNECTION_PROVIDERS], connectionsWithSecret: ['acme-jira'], dataDir: '/tmp/example' })

const saveConnection = vi.fn(async (_c: Connection, _s: SecretChange): Promise<Result<WorkhubConfig>> => ({ ok: true, value: emptyConfig() }) as never)
const saveOptions = vi.fn(async (): Promise<Result<WorkhubConfig>> => ({ ok: true, value: emptyConfig() }) as never)
const run = vi.fn(async (op: () => Promise<Result<WorkhubConfig>>) => (await op()).ok)

beforeEach(() => {
  controls.length = 0
  saveConnection.mockClear()
  saveOptions.mockClear()
  vi.stubGlobal('window', { hub: { config: { saveConnection, saveOptions, deleteConnection: async () => ({ ok: true }) } } })
})
afterEach(() => vi.unstubAllGlobals())

const control = (name: string) => {
  const found = controls.find((c) => c['aria-label'] === name || c['data-testid'] === name)
  if (!found) throw new Error(`no control "${name}"; have: ${controls.map((c) => c['aria-label'] ?? c['data-testid']).join(' | ')}`)
  return found
}

describe('Settings → Connections model', () => {
  it('groups the connections by kind, in the order of the section', () => {
    const groups = groupConnections(config().connections)
    expect(groups.map((g) => g.id)).toEqual(['code', 'tickets', 'calendars', 'slack', 'health'])
    expect(groups.map((g) => g.connections.map((c) => c.id))).toEqual([['acme-github', 'acme-gitlab'], ['acme-jira'], ['work-calendar'], [], ['elastic']])
  })

  it('lists which profiles use a connection, and for which screen', () => {
    expect(connectionUses(config(), 'acme-github').map((u) => [u.profileName, u.screen])).toEqual([
      ['Acme web', 'settingsConnections.screen.pullRequests'],
      ['Side project', 'settingsConnections.screen.pullRequests']
    ])
    expect(connectionUses(config(), 'work-calendar').map((u) => u.screen)).toEqual(['settingsConnections.screen.plan'])
    expect(connectionUses(config(), 'acme-gitlab')).toEqual([])
  })

  it('checks the named fields of each kind before saving', () => {
    expect(connectionProblem({ ...jira, endpoint: '' }, '', true)).toBe('trackers.missing.site')
    expect(connectionProblem(jira, '', false)).toBe('trackers.missing.token')
    expect(connectionProblem(jira, '', true)).toBeNull()
    expect(connectionProblem(calendar, 'ftp://nope', false)).toBe('plan.settings.badAddress')
    expect(connectionProblem({ ...elastic, settings: { tls: 'pinned', tlsFingerprint: 'ab' } }, 'key', false)).toBe('health.settings.missing.fingerprint')
    expect(connectionProblem(github, '', false)).toBeNull()
  })

  it('stores a new connection with an id from its name, trimmed values and a Jira site as a URL', () => {
    const next = connectionToSave({ id: '', kind: 'tracker', provider: 'jira', name: ' Team Jira ', endpoint: 'team.example.com', settings: { email: ' dev@example.com ', projectKeys: '' } }, ['team-jira'])
    expect(next).toEqual({ id: 'team-jira-2', kind: 'tracker', provider: 'jira', name: 'Team Jira', endpoint: 'https://team.example.com', settings: { email: 'dev@example.com' } })
  })
})

describe('Settings → Connections section', () => {
  const render = (snap = snapshot()) => renderToStaticMarkup(createElement(TooltipProvider, null, createElement(ConnectionsSection, { snap, run })))

  it('renders one group per kind, a card per connection with its users, and the app-wide parts once', () => {
    const html = render()
    expect([...html.matchAll(/data-group="(\w+)"/g)].map((m) => m[1])).toEqual(['code', 'tickets', 'calendars', 'slack', 'health'])
    expect(html.match(/data-testid="connection-card"/g)).toHaveLength(5)
    expect(html).toContain('Used by Acme web · Pull requests, Side project · Pull requests')
    expect(html).toContain('Used by Acme web · Tickets')
    expect(html).toContain('Used by Acme web · Plan')
    // Two code hosts, but the branches Close PR never deletes are app-wide: shown once.
    expect(html.match(/data-testid="connections-protected-branches"/g)).toHaveLength(1)
    expect(html.match(/aria-label="Protected branches"/g)).toHaveLength(1)
    expect(html.match(/data-testid="slack-watcher-stand-in"/g)).toHaveLength(1)
    expect(html.match(/data-testid="connections-health-floor"/g)).toHaveLength(1)
    for (const row of CONNECTIONS_INDEX) expect(html).toContain(`data-setting-id="${row.id}"`)
    control('connections-add-github')
    control('connections-add-jira')
    control('connections-add-ics')
  })

  it('"Read at most every" writes the app-wide Health floor', async () => {
    render()
    ;(control('Read at most every').onChange as (v: string) => void)('30')
    await new Promise((r) => setTimeout(r, 0))
    expect(saveOptions).toHaveBeenCalledWith({ healthRefreshFloorMinutes: 30 })
  })

  it('opens a tracker with its named fields, not key=value lines, and saves it with its secret kept', async () => {
    renderToStaticMarkup(createElement(TooltipProvider, null, createElement(ConnectionEditor, { snap: snapshot(), run, connection: jira, kind: 'tracker', provider: 'jira', onClose: () => {} })))
    expect(control('Project keys').value).toBe('WEB')
    expect(control('Account email').value).toBe('dev@example.com')
    expect(controls.some((c) => c['aria-label'] === 'Settings (key=value per line)')).toBe(false)
    await (control('connection-save').onClick as () => Promise<void>)()
    expect(saveConnection).toHaveBeenCalledWith(jira, { action: 'keep' })
  })
})
