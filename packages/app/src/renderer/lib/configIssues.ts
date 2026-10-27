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

const PROFILE_ID = /^[a-z0-9][a-z0-9._-]*$/

/** What is wrong with a profile form, per field, before anything is sent to be saved. */
export function profileFieldErrors(profile: { id: string; name: string }, takenIds: readonly string[] = []): { id?: MessageKey; name?: MessageKey } {
  const errors: { id?: MessageKey; name?: MessageKey } = {}
  if (!profile.name.trim()) errors.name = 'issues.profileName'
  if (!profile.id) errors.id = 'issues.profileIdMissing'
  else if (!PROFILE_ID.test(profile.id)) errors.id = 'issues.profileId'
  else if (takenIds.includes(profile.id)) errors.id = 'issues.profileIdTaken'
  return errors
}

/** What is wrong with an agent account form, per field, before anything is sent to be saved. */
export function accountFieldErrors(account: { id: string; name: string }, takenIds: readonly string[] = []): { id?: MessageKey; name?: MessageKey } {
  const errors: { id?: MessageKey; name?: MessageKey } = {}
  if (!account.name.trim()) errors.name = 'issues.accountName'
  if (!account.id) errors.id = 'issues.accountIdMissing'
  else if (!PROFILE_ID.test(account.id)) errors.id = 'issues.profileId'
  else if (takenIds.includes(account.id)) errors.id = 'issues.accountIdTaken'
  return errors
}

/** Form labels for the fields a validation issue can name, so a message names the field, not its path. */
const FIELD_LABEL: Record<string, MessageKey> = {
  id: 'settings.id',
  name: 'settings.name',
  configDir: 'settings.configDir',
  command: 'settings.accountCommand',
  defaultModel: 'settings.defaultModel',
  defaultMode: 'settings.defaultMode'
}

/**
 * A validation issue as one friendly sentence. Shape rules from the schema (they carry a `code`)
 * and unexpected failures never show their raw text; cross-reference messages are already plain.
 */
export function friendlyIssue(issue: ValidationIssue, t: (key: MessageKey, params?: Params) => string): string {
  if (issue.code === 'unexpected') return t('issues.unexpected')
  if (!issue.code) return `${issue.path}: ${issue.message}`
  const [section, , field] = issue.path.split('.')
  if (section === 'profiles' && field === 'name') return t('issues.profileName')
  if (section === 'profiles' && field === 'id') return t(issue.code === 'too_small' ? 'issues.profileIdMissing' : 'issues.profileId')
  if (section === 'accounts' && field === 'name') return t('issues.accountName')
  if (section === 'accounts' && field === 'id') return t(issue.code === 'too_small' ? 'issues.accountIdMissing' : 'issues.profileId')
  // Never the config path ("accounts.#2.id"): the field's own label, or its last segment.
  const last = issue.path.split('.').filter((p) => !p.startsWith('#')).pop() ?? issue.path
  return t('issues.invalidValue', { where: FIELD_LABEL[last] ? t(FIELD_LABEL[last]!) : last })
}
