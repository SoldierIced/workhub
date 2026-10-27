import type { ConnectionKind, ConnectionProvider, ValidationIssue, WorkhubConfig } from '@workhub/core'
import type { MessageKey, Params } from '../i18n/translate'

/** Where a fix lives: a Settings tab and, when there is one, the item to open in it. */
export interface IssueTarget {
  tab: 'connections' | 'trackers' | 'health' | 'profiles' | 'accounts'
  id?: string
}

/** A stored-config problem in plain words, with the action that fixes it. */
export interface HumanIssue {
  key: string
  message: MessageKey
  params: Params
  action?: { label: MessageKey; target: IssueTarget }
  /** The validator's own path and text, kept for a tooltip. */
  technical: string
}

const KIND_KEY: Record<ConnectionKind, MessageKey> = { codeHost: 'kind.codeHost', tracker: 'kind.tracker', chat: 'kind.chat', health: 'kind.health' }

/**
 * Turns a validation issue (`connections.jira-acme.secretRef: a secret is required`) into a sentence
 * a person can act on ("Jira (jira-acme) needs its token", Enter token) and the Settings place that
 * fixes it. Unknown shapes keep the technical text.
 */
export function humanIssue(issue: ValidationIssue, config: WorkhubConfig, providers: readonly ConnectionProvider[], label: (key: MessageKey) => string): HumanIssue {
  const technical = `${issue.path}: ${issue.message}`
  const key = technical
  const [section, id = '', field = ''] = issue.path.split('.')
  const raw: HumanIssue = { key, message: 'issues.raw', params: { path: issue.path, message: issue.message }, technical }

  if (section === 'connections') {
    const c = config.connections.find((x) => x.id === id)
    if (!c) return raw
    const provider = providers.find((p) => p.id === c.provider)
    const name = c.name || (provider ? `${provider.name} (${c.id})` : c.id)
    const activeProfile = config.profiles.find((p) => p.id === config.activeProfileId)
    // Trackers and the active profile's Health connection have their own, friendlier forms.
    const target: IssueTarget =
      c.kind === 'tracker' ? { tab: 'trackers', id: c.id } : c.kind === 'health' && activeProfile?.connections.health === c.id ? { tab: 'health', id: c.id } : { tab: 'connections', id: c.id }
    if (field === 'secretRef') return { key, message: 'issues.secret', params: { name }, action: { label: 'issues.secret.action', target }, technical }
    if (field === 'endpoint' && /required/.test(issue.message)) return { key, message: 'issues.endpoint', params: { name }, action: { label: 'issues.endpoint.action', target }, technical }
    if (field === 'endpoint') return { key, message: 'issues.endpointUrl', params: { name }, action: { label: 'issues.endpoint.action', target }, technical }
    if (field === 'provider') return { key, message: 'issues.provider', params: { name, provider: c.provider }, action: { label: 'issues.edit', target: { tab: 'connections', id: c.id } }, technical }
    return { ...raw, action: { label: 'issues.edit', target: { tab: 'connections', id: c.id } } }
  }

  if (section === 'profiles') {
    const p = config.profiles.find((x) => x.id === id)
    if (!p) return raw
    const target: IssueTarget = { tab: 'profiles', id: p.id }
    const name = p.name || p.id
    const kind = issue.path.split('.')[3] as ConnectionKind | undefined
    if (field === 'connections' && kind && kind in KIND_KEY) return { key, message: 'issues.profileConnection', params: { name, kind: label(KIND_KEY[kind]) }, action: { label: 'issues.editProfile', target }, technical }
    if (field === 'accountIds') return { key, message: 'issues.profileAccount', params: { name }, action: { label: 'issues.editProfile', target }, technical }
    if (field === 'agentIds') return { key, message: 'issues.profileAgent', params: { name }, action: { label: 'issues.editProfile', target }, technical }
    return { ...raw, action: { label: 'issues.editProfile', target } }
  }

  if (section === 'accounts') {
    const a = config.accounts.find((x) => x.id === id)
    if (!a) return raw
    const target: IssueTarget = { tab: 'accounts', id: a.id }
    if (field === 'agentId') return { key, message: 'issues.accountAgent', params: { name: a.name || a.id, agent: a.agentId }, action: { label: 'issues.edit', target }, technical }
    return { ...raw, action: { label: 'issues.edit', target } }
  }

  return raw
}
