import type { EventLedger } from '../chat/ledger'

/**
 * An automation sends a prompt or slash command to a dedicated, visible session when a chat
 * message arrives and/or every so often, inside a time window and under rate limits (Workhub 1's
 * replacement for leaving a session running `/loop 5m /some-skill`). Stored in config.json.
 */
export interface AutomationDefinition {
  id: string
  name: string
  enabled: boolean
  /** What is sent to the session: a slash command or any prompt. */
  prompt: string
  /** The profile it belongs to; it runs only while that profile has the Automations module on. */
  profileId: string | null
  /** `effectiveAgentKey` of the agent and account that run it. */
  agentKey: string
  /** The folder the session runs in; `~` is expanded by the app. */
  folder: string
  /** `app` (the chat) or `console` (the agent's own terminal UI, or a terminal agent). */
  view: 'app' | 'console'
  /** Model the session starts with; the account's default when unset. */
  model?: string
  /** Reasoning effort (Claude only); unset: the account's setting. */
  effort?: string
  /** Permission mode the session starts in: a Claude mode, or a mode id the agent offers; unset: the account's default. */
  permissionMode?: string
  triggers: AutomationTriggers
  window: AutomationWindow
  limits: AutomationLimits
  /** Automatic runs wait while the account's 5 h usage is at or above this percentage. */
  usageThreshold: number
  sessionPolicy: SessionPolicy
  runTimeoutMinutes: number
  /** Whether replies to the chat messages its sessions send wake them. Off: those threads are not followed. */
  receivesChatReplies: boolean
}

/** Reasoning efforts Claude Code accepts, lowest first. */
export const AUTOMATION_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

/** Claude Code's permission modes an unattended run can start in (Workhub 1's list). */
export const CLAUDE_PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'] as const

/**
 * `reuse`: one dedicated session, resumed when it is closed. `newEachRun`: a fresh session per
 * run; the new one takes the previous one's sidebar place and the threads it listens to.
 */
export type SessionPolicy = 'reuse' | 'newEachRun'

export interface AutomationTriggers {
  /** Fire when the watcher stores a new message with a PR link in one of these channels. */
  chatChannelIds: string[]
  /** Only PR links of this owner (GitHub org or user) count; empty accepts any. */
  prOwner: string
  /** Every N minutes, inside the window; null for no periodic run. */
  intervalMinutes: number | null
  /** When set, an interval tick only starts a run if this zero-token check finds pending work. */
  pendingGate?: PendingGate
}

/** A model-free check of a skill's JSON state file that decides whether an interval tick is worth a run. */
export interface PendingGate {
  kind: 'prReviewQueue'
  /** Path of the skill's JSON state file. */
  stateFile: string
}

export interface AutomationWindow {
  /** JavaScript weekdays, 0 = Sunday. */
  days: number[]
  startHour: number
  endHour: number
}

export interface AutomationLimits {
  /** At most `maxRuns` started in any sliding `perMinutes` minutes. */
  maxRuns: number
  perMinutes: number
  maxPerDay: number | null
}

export type AutomationOutcome = 'ok' | 'error' | 'rateLimited' | 'timeout' | 'skipped' | 'coalesced' | 'stopped'

export const FAILURE_OUTCOMES: readonly AutomationOutcome[] = ['error', 'rateLimited', 'timeout']

export type AutomationTrigger = 'chat' | 'interval' | 'manual'

/** One run of an automation, for the log. */
export interface AutomationRun {
  id: string
  automationId: string
  /** The automation's name when the run was logged, still shown once it is removed. */
  automationName: string
  trigger: AutomationTrigger
  /** The chat message the run was triggered by, when there is one. */
  triggerLink?: string
  /** Epoch milliseconds. */
  queuedAt: number
  startedAt?: number
  endedAt?: number
  outcome: AutomationOutcome
  /** Why it was skipped or failed; a code the UI words (`window.days`, `limit.day`…) or the agent's text. */
  detail?: string
  /** The session's stable identity. */
  session?: string
  /** Further triggers merged into this run while it waited. */
  merged: number
}

/** What the engine keeps between launches (the app stores it in its data folder). */
export interface AutomationsState {
  /** Per automation: the identity of its current dedicated session. */
  sessions: Record<string, string>
  /** Every session identity an automation ran in (current and replaced), with its automation id. */
  owned: Record<string, string>
  /** Replaced sessions to stop once they are idle and no chat thread wakes them. */
  retiring: string[]
  /** The last runs, newest first. */
  runs: AutomationRun[]
  /** Per automation: start times (epoch ms) of the last two days, for the limits. */
  starts: Record<string, number[]>
  /** Chat events that already fired a run. */
  ledger: EventLedger
}

export const EMPTY_AUTOMATIONS_STATE: AutomationsState = { sessions: {}, owned: {}, retiring: [], runs: [], starts: {}, ledger: {} }

export const RUN_LOG_LIMIT = 50

/** A blank automation with Workhub 1's defaults. */
export function newAutomation(id: string, fields: Partial<AutomationDefinition> = {}): AutomationDefinition {
  return {
    id,
    name: 'New automation',
    enabled: true,
    prompt: '',
    profileId: null,
    agentKey: 'claude',
    folder: '~',
    view: 'app',
    triggers: { chatChannelIds: [], prOwner: '', intervalMinutes: null },
    window: { days: [1, 2, 3, 4, 5], startHour: 9, endHour: 19 },
    limits: { maxRuns: 6, perMinutes: 5, maxPerDay: 60 },
    usageThreshold: 85,
    sessionPolicy: 'reuse',
    runTimeoutMinutes: 30,
    receivesChatReplies: true,
    ...fields
  }
}

/**
 * "PR reviews from Slack": a run on every PR message of the watched review channels, a new
 * session each run. Nothing in it is personal: the channels come from the watcher, the owner
 * from a profile scope of exactly `org:<owner>`, and the prompt is left for the user.
 */
export function prReviewsPreset(id: string, fields: { profileId: string | null; agentKey: string; folder: string; channels: { id: string; name: string; purpose: string }[]; scope?: string }): AutomationDefinition {
  const reviewing = fields.channels.filter((c) => /review/i.test(`${c.name} ${c.purpose}`))
  const terms = (fields.scope ?? '').trim().split(/\s+/)
  const owner = terms.length === 1 && terms[0]!.startsWith('org:') ? terms[0]!.slice(4) : ''
  return newAutomation(id, {
    name: 'PR reviews',
    profileId: fields.profileId,
    agentKey: fields.agentKey,
    folder: fields.folder,
    sessionPolicy: 'newEachRun',
    triggers: { chatChannelIds: (reviewing.length ? reviewing : fields.channels).map((c) => c.id), prOwner: owner, intervalMinutes: null }
  })
}
