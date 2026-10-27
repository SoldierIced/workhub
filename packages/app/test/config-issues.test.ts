import { describe, expect, it } from 'vitest'
import { emptyConfig, type ConnectionProvider, type WorkhubConfig } from '@workhub/core'
import { errorText } from '../src/renderer/lib/errorText'
import { accountFieldErrors, friendlyIssue, humanIssue, profileFieldErrors } from '../src/renderer/lib/configIssues'

const providers = [
  { id: 'jira', kind: 'tracker', name: 'Jira', requiresSecret: true, requiresEndpoint: true },
  { id: 'elasticsearch', kind: 'health', name: 'Elasticsearch', requiresSecret: true, requiresEndpoint: true },
  { id: 'github', kind: 'codeHost', name: 'GitHub', requiresSecret: false, requiresEndpoint: false }
] as unknown as ConnectionProvider[]

function config(): WorkhubConfig {
  return {
    ...emptyConfig(),
    connections: [
      { id: 'jira-acme', kind: 'tracker', provider: 'jira', settings: {} },
      { id: 'elastic-acme', kind: 'health', provider: 'elasticsearch', name: 'Elastic (acme)', settings: {} },
      { id: 'elastic-old', kind: 'health', provider: 'elasticsearch', settings: {} }
    ],
    accounts: [{ id: 'claude-work', agentId: 'ghost', name: 'Claude laboral' }],
    profiles: [{ id: 'acme', name: 'Acme', connections: { health: 'elastic-acme', codeHost: 'gone' }, accountIds: [], modules: { flows: false, health: true, chatWatcher: false, automations: false } }],
    activeProfileId: 'acme'
  }
}
const label = (k: string) => `[${k}]`

describe('stored config problems in plain words', () => {
  it('asks for a tracker token and opens the tracker form', () => {
    const h = humanIssue({ path: 'connections.jira-acme.secretRef', message: 'a secret is required' }, config(), providers, label)
    expect(h.message).toBe('issues.secret')
    expect(h.params).toEqual({ name: 'Jira (jira-acme)' })
    expect(h.action).toEqual({ label: 'issues.secret.action', target: { tab: 'trackers', id: 'jira-acme' } })
    expect(h.technical).toBe('connections.jira-acme.secretRef: a secret is required')
  })

  it("sends the active profile's Health connection to the Health tab and others to Connections", () => {
    expect(humanIssue({ path: 'connections.elastic-acme.secretRef', message: 'a secret is required' }, config(), providers, label).action?.target).toEqual({ tab: 'health', id: 'elastic-acme' })
    expect(humanIssue({ path: 'connections.elastic-old.endpoint', message: 'endpoint is required' }, config(), providers, label)).toMatchObject({
      message: 'issues.endpoint',
      action: { target: { tab: 'connections', id: 'elastic-old' } }
    })
  })

  it('explains broken profile and account references', () => {
    expect(humanIssue({ path: 'profiles.acme.connections.codeHost', message: 'unknown connection "gone"' }, config(), providers, label)).toMatchObject({
      message: 'issues.profileConnection',
      params: { name: 'Acme', kind: '[kind.codeHost]' },
      action: { target: { tab: 'profiles', id: 'acme' } }
    })
    expect(humanIssue({ path: 'accounts.claude-work.agentId', message: 'unknown agent "ghost"' }, config(), providers, label)).toMatchObject({ message: 'issues.accountAgent', params: { name: 'Claude laboral', agent: 'ghost' } })
  })

  it('keeps the technical text for anything else', () => {
    const h = humanIssue({ path: 'activeProfileId', message: 'unknown profile "x"' }, config(), providers, label)
    expect(h.message).toBe('issues.raw')
    expect(h.params).toEqual({ path: 'activeProfileId', message: 'unknown profile "x"' })
    expect(h.action).toBeUndefined()
  })
})

describe('friendly messages', () => {
  const t = (k: string, p?: Record<string, unknown>) => `${k}${p ? JSON.stringify(p) : ''}`
  it('maps schema issues to sentences, never JSON', () => {
    expect(friendlyIssue({ path: 'profiles.#2.name', message: 'Too small', code: 'too_small' }, t)).toBe('issues.profileName')
    expect(friendlyIssue({ path: 'profiles.#2.id', message: 'Too small', code: 'too_small' }, t)).toBe('issues.profileIdMissing')
    expect(friendlyIssue({ path: 'profiles.Bad.id', message: 'x', code: 'invalid_format' }, t)).toBe('issues.profileId')
    expect(friendlyIssue({ path: 'config', message: '[{"code":"x"}]', code: 'unexpected' }, t)).toBe('issues.unexpected')
  })

  it('names an account field instead of its config path', () => {
    const t = (k: string, p?: Record<string, string | number>) => (p ? `${k}:${JSON.stringify(p)}` : k)
    expect(friendlyIssue({ path: 'accounts.#2.id', message: 'Too small', code: 'too_small' }, t)).toBe('issues.accountIdMissing')
    expect(friendlyIssue({ path: 'accounts.#2.name', message: 'Too small', code: 'too_small' }, t)).toBe('issues.accountName')
    expect(friendlyIssue({ path: 'accounts.#2.configDir', message: 'x', code: 'invalid_type' }, t)).toBe('issues.invalidValue:{"where":"settings.configDir"}')
    expect(friendlyIssue({ path: 'options.speechRate', message: 'x', code: 'too_big' }, t)).not.toContain('options.')
  })

  it('validates an account form per field', () => {
    expect(accountFieldErrors({ id: '', name: ' ' })).toEqual({ id: 'issues.accountIdMissing', name: 'issues.accountName' })
    expect(accountFieldErrors({ id: 'Work Acc', name: 'Work' })).toEqual({ id: 'issues.profileId' })
    expect(accountFieldErrors({ id: 'work', name: 'Work' }, ['work'])).toEqual({ id: 'issues.accountIdTaken' })
  })

  it('validates a profile form per field', () => {
    expect(profileFieldErrors({ id: '', name: '' })).toEqual({ id: 'issues.profileIdMissing', name: 'issues.profileName' })
    expect(profileFieldErrors({ id: 'Bad Id', name: 'x' })).toEqual({ id: 'issues.profileId' })
    expect(profileFieldErrors({ id: 'acme', name: 'Acme' }, ['acme'])).toEqual({ id: 'issues.profileIdTaken' })
    expect(profileFieldErrors({ id: 'acme', name: 'Acme' })).toEqual({})
  })

  it('hides dumped validation errors from error text', () => {
    expect(errorText(new Error("Error invoking remote method 'config:saveProfile': ZodError: [ { \"code\": \"too_small\" } ]"))).toBe('Something went wrong. Please try again.')
    expect(errorText(new Error("Error invoking remote method 'x': Error: disk full"))).toBe('disk full')
  })
})
