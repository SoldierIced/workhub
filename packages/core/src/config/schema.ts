import { z } from 'zod'
import { CHROME_PROFILE_DIR, ENV_NAME } from '../domain/profile'
import type { AgentAccount, AgentDefinition } from '../domain/agent'
import { CONNECTION_KINDS, type Connection } from '../domain/connection'
import { OPTIONAL_MODULES, type Profile } from '../domain/profile'
import type { SessionGroups } from '../domain/session-groups'
import { ALERT_SEVERITIES, METRIC_ALERT_THRESHOLD_RANGES, DEFAULT_METRIC_ALERT_THRESHOLDS, DEFAULT_BUSINESS_DAYS, type AlertThresholds } from '../alerts/types'
import { DEFAULT_HEALTH_FLOOR_MINUTES, DEFAULT_HEALTH_REFRESH_MINUTES, DEFAULT_HEALTH_THRESHOLDS, HEALTH_FLOOR_CHOICES, HEALTH_THRESHOLD_RANGES, MAX_HEALTH_REFRESH_MINUTES, MIN_HEALTH_REFRESH_MINUTES, type HealthThresholds } from '../health/types'
import { HEALTH_ALERT_CHANNELS, HEALTH_ALERT_KINDS, HEALTH_ALERT_THRESHOLDS } from '../health/alert-settings'
import { DEFAULT_PR_EVENT_TOGGLES, PR_EVENT_KINDS, type PrEventToggles } from '../pr-events/types'
import type { ChatWatcherSettings } from '../chat/types'
import type { AutomationDefinition } from '../automations/types'
import { DEFAULT_AI_REVIEW_SETTINGS as AI_REVIEW, MAX_REVIEW_IDLE_SECONDS, MAX_REVIEW_ROUNDS, MIN_REVIEW_IDLE_SECONDS, MIN_REVIEW_ROUNDS } from '../ai-review/defaults'
import { REVIEW_LANGUAGES, REVIEWER_SESSION_MODES } from '../ai-review/types'
import { DEFAULT_USAGE_BUDGET, type UsageBudgetOptions } from '../usage/budget'
import { AGENT_MILESTONE_MODES, MILESTONE_MARGIN_RANGE } from '../milestones'
import { INBOX_LIMITS } from '../inbox/types'
import { DEFAULT_WORKTREE_SETTINGS, WORKTREE_CLOSE_MODES } from '../worktrees/settings'
import { DEFAULT_PLANNER_REFRESH_MINUTES, DEFAULT_REMINDER_LEAD_MINUTES, MAX_LEAD_MINUTES, MAX_PLANNER_REFRESH_MINUTES, MIN_PLANNER_REFRESH_MINUTES } from '../calendar/types'

/**
 * The persisted config. A change an older build cannot read (a field renamed, removed, retyped or
 * made required) bumps `CONFIG_VERSION` and adds a migration in `migrations.ts`. A new optional
 * field with a default needs no bump: older files load with the default, and an older build
 * strips the field on its next save. Secrets are never part of it (only `secretRef` keys).
 */
export const CONFIG_VERSION = 8

export interface WorkhubConfig {
  version: typeof CONFIG_VERSION
  connections: Connection[]
  /** User-defined agents; one with a built-in id replaces the built-in agent. */
  agents: AgentDefinition[]
  accounts: AgentAccount[]
  profiles: Profile[]
  activeProfileId?: string
  /** App-wide switches; see `appOptions` for the defaults. */
  options?: AppOptions
  /** Sidebar session groups and the order of the Sessions section. */
  sessionGroups?: SessionGroups
  /** The chat (Slack) watcher's settings; see `chatWatcherSettings` for the defaults. */
  chatWatcher?: ChatWatcherSettings
  /** Automations, edited on the Automations screen. Their runs and sessions live in the data folder. */
  automations?: AutomationDefinition[]
}

export interface AppOptions {
  /**
   * Read Claude plan usage (5 h and weekly windows) from Anthropic's undocumented OAuth usage
   * endpoint with each account's own Claude Code login, as Workhub 1 does. Off by default
   * (PLAN section 6): the endpoint is not a public API and may change or be refused.
   */
  claudePlanUsage: boolean
  /** OS notification when a session finishes a turn while it is not on screen. */
  notifyReplied: boolean
  /** OS notification when a session asks for a permission or an answer. */
  notifyNeedsAnswer: boolean
  /** OS notification when a session fails. */
  notifyError: boolean
  /** Look for a newer release on GitHub at startup and from Settings. Off by default (nothing is contacted unless asked). */
  checkForUpdates: boolean
  /** OS notification per kind of pull request event (Settings → Notifications). */
  notifyPrEvents: PrEventToggles
  /**
   * Read Codex plan usage (5 h and weekly windows) per account: ChatGPT's undocumented Codex usage
   * endpoint with the account's own Codex sign-in, else the newest rate limits in its session
   * files. Off by default, like `claudePlanUsage`.
   */
  codexUsage: boolean
  /**
   * Read Kiro credits used and left this billing cycle by asking `kiro-cli` its own `/usage`
   * (Kiro's sign-in, never read by Workhub). On by default: a read starts Kiro briefly, at most
   * every 15 minutes while Workhub runs, in a Kiro home of Workhub's own (no user MCP servers, no
   * session in Kiro's list).
   */
  kiroUsage: boolean
  /** Ceilings, warning margin and alerts per account (Settings → Usage). */
  usageBudget: UsageBudgetOptions
  /** OS notification for watched Slack channels, tracked thread replies and watcher failures. */
  notifySlack: boolean
  /** OS notification when an automation fails. */
  notifyAutomations: boolean
  /** OS notification when an assigned ticket changes status, is assigned or leaves the list. */
  notifyTickets: boolean
  /** OS notification when a Health environment degrades, becomes unreachable or recovers, a service stops reporting, a pod stops being ready or an error signal starts worsening. */
  notifyHealth: boolean
  /** OS notification when a part of a flow map goes above its p95 or failure limit. */
  notifyFlowMaps: boolean
  /** OS notification before a meeting (Plan reminders and reminder rules). */
  notifyMeetings: boolean
  /** OS notification when a metric alert opens or escalates at or above the profile's minimum severity (Health → Alerts). */
  notifyMetricAlerts: boolean
  /** Health never reads Elasticsearch more often than this, even on Refresh (minutes, one of `HEALTH_FLOOR_CHOICES`). */
  healthRefreshFloorMinutes: number
  /** Closing the main window keeps the app running in the menu bar / notification area. */
  keepInTray: boolean
  /** The sessions open when the app quit are reopened (resumed) at the next launch. */
  reopenSessions: boolean
  /** A badge on the app icon (Dock, taskbar, launcher) with the number of sessions that need a look. */
  showAppBadge: boolean
  /** What the menu bar popover shows (Settings → Notifications → Menu bar panel). */
  trayPopover: TrayPopoverOptions
  /** Master switch: off silences every OS notification, whatever the per-kind switches say. */
  notificationsEnabled: boolean
  /** Read each finished reply aloud in new sessions (a session's own toggle overrides it). */
  readAloud: boolean
  /** The voice that reads replies aloud, by name; empty: the system voice. */
  speechVoice: string
  /** Speaking speed in words per minute (`SPEECH_RATE_RANGE`). */
  speechRate: number
  /**
   * The model that summarizes a long agent message before the chat's Listen button reads it
   * (a Claude model alias or id; empty: `DEFAULT_LISTEN_MODEL`). Each summary is a small paid query.
   */
  listenModel: string
  /** The first-run welcome window was shown (or the user already had profiles). */
  welcomeDone: boolean
  /**
   * Branches Close PR never deletes (Settings → Pull requests). Unset: `DEFAULT_PROTECTED_BRANCHES`.
   * `release…` branches are always kept.
   */
  protectedBranches?: string[]
  /** "Pause notifications": nothing is shown until this moment (epoch ms). Unset when not paused. */
  notificationsPausedUntil?: number
  /**
   * The mode a new session of an agent starts in when neither the session nor its account picks
   * one (Settings → Agents), by agent id: Claude's permission mode, an ACP agent's mode (Codex's
   * approval preset), Kiro's agent. Unset: the agent's own default.
   */
  agentDefaultModes?: Record<string, string>
}

/** The blocks of the menu bar popover that can be hidden, and how many meetings "Today" lists. */
export interface TrayPopoverOptions {
  /** Today's next meetings (Plan's calendars). */
  meetings: boolean
  /** How many of them, at most. */
  meetingCount: 1 | 2 | 3
  /** Plan inbox tasks due today (or overdue). */
  plan: boolean
  /** The pull request counts, while the profile has a code host. */
  pullRequests: boolean
  /** Health, while it is not healthy. */
  health: boolean
  /** One usage bar per agent account. */
  usage: boolean
  /** Recent notifications. */
  recent: boolean
}

export const TRAY_POPOVER_MEETING_COUNTS = [1, 2, 3] as const
export const DEFAULT_TRAY_POPOVER_OPTIONS: TrayPopoverOptions = { meetings: true, meetingCount: 2, plan: true, pullRequests: true, health: true, usage: true, recent: true }

/** Words per minute the voice speaks at (Workhub 1's range). */
export const SPEECH_RATE_RANGE = [120, 300] as const
export const DEFAULT_SPEECH_RATE = 190
/** The cheap model a long message is summarized with before it is read aloud. */
export const DEFAULT_LISTEN_MODEL = 'haiku'

export const DEFAULT_OPTIONS: AppOptions = { claudePlanUsage: false, notifyReplied: true, notifyNeedsAnswer: true, notifyError: true, checkForUpdates: false, notifyPrEvents: DEFAULT_PR_EVENT_TOGGLES, codexUsage: false, kiroUsage: true, usageBudget: DEFAULT_USAGE_BUDGET, notifySlack: true, notifyAutomations: true, notifyTickets: true, notifyHealth: true, notifyFlowMaps: true, notifyMeetings: true, notifyMetricAlerts: true, healthRefreshFloorMinutes: DEFAULT_HEALTH_FLOOR_MINUTES, keepInTray: true, reopenSessions: true, showAppBadge: true, trayPopover: DEFAULT_TRAY_POPOVER_OPTIONS, notificationsEnabled: true, readAloud: false, speechVoice: '', speechRate: DEFAULT_SPEECH_RATE, listenModel: DEFAULT_LISTEN_MODEL, welcomeDone: false }

export function appOptions(config: Pick<WorkhubConfig, 'options'>): AppOptions {
  const options = { ...DEFAULT_OPTIONS, ...config.options }
  return { ...options, trayPopover: { ...DEFAULT_TRAY_POPOVER_OPTIONS, ...config.options?.trayPopover } }
}

/** The per-agent default modes with one agent's set (or cleared, for an empty or null mode). */
export function withAgentDefaultMode(modes: Readonly<Record<string, string>> | undefined, agentId: string, modeId: string | null): Record<string, string> {
  const next = { ...modes }
  const mode = modeId?.trim()
  if (mode) next[agentId] = mode
  else delete next[agentId]
  return next
}

/**
 * The mode a new session starts in when it picks none: its account's default, else the agent's
 * default (Settings → Agents), else undefined (the agent's own default applies).
 */
export function defaultStartMode(config: Pick<WorkhubConfig, 'options'>, agentId: string, account: { defaultMode?: string } | null | undefined): string | undefined {
  return account?.defaultMode?.trim() || config.options?.agentDefaultModes?.[agentId]?.trim() || undefined
}

export function emptyConfig(): WorkhubConfig {
  return { version: CONFIG_VERSION, connections: [], agents: [], accounts: [], profiles: [] }
}

const id = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, 'lowercase letters, digits, ".", "_" or "-"')

const stringMap = z.record(z.string(), z.string())

const capabilities = z.object({
  appMode: z.boolean(),
  transcript: z.boolean(),
  usage: z.boolean(),
  planUsage: z.boolean(),
  history: z.boolean(),
  hooks: z.boolean(),
  models: z.boolean(),
  mcpStatus: z.boolean(),
  mcpControl: z.boolean(),
  subagents: z.boolean(),
  permissionRequests: z.boolean(),
  imageInput: z.boolean().default(false),
  midTurnInput: z.boolean().optional()
})

const consoleLaunch = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  resumeArgs: z.array(z.string()).optional(),
  newSessionArgs: z.array(z.string()).optional(),
  modelArgs: z.array(z.string()).optional()
})

const connection = z.object({
  id,
  kind: z.enum(CONNECTION_KINDS),
  provider: z.string().min(1),
  name: z.string().optional(),
  endpoint: z.string().optional(),
  secretRef: z.string().min(1).optional(),
  settings: stringMap.default({})
})

const agent = z.object({
  id,
  name: z.string().min(1),
  adapter: z.enum(['native', 'acp', 'terminal']),
  command: z.string(),
  args: z.array(z.string()).default([]),
  env: stringMap.optional(),
  capabilities,
  modeSemantics: z.enum(['permission', 'persona', 'none']).default('none'),
  accountConfigEnv: z.string().optional(),
  console: consoleLaunch.optional(),
  modelArgs: z.array(z.string()).optional(),
  effortArgs: z.array(z.string()).optional(),
  transcript: z.string().optional(),
  accountsOf: id.optional(),
  builtIn: z.boolean().optional()
})

const account = z.object({
  id,
  agentId: id,
  name: z.string().min(1),
  configDir: z.string().optional(),
  env: stringMap.optional(),
  // Variable names only; the values are in the secret store (`accountEnvRef`).
  envNames: z.array(z.string().regex(ENV_NAME)).optional(),
  // Optional, so older files load unchanged (no version bump).
  command: z.string().trim().min(1).max(1000).optional(),
  defaultModel: z.string().trim().min(1).max(200).optional(),
  defaultMode: z.string().trim().min(1).max(200).optional()
})

/** A number clamped into a range, as Workhub 1 did: a hand-edited out-of-range value never keeps the config from loading. */
const clamped = (range: readonly [number, number], fallback: number) =>
  z
    .number()
    .default(fallback)
    .transform((n) => Math.min(range[1], Math.max(range[0], Math.round(n))))

/** A whole number of at least `min`, raised to it (and rounded) instead of refused, like `clamped`. */
const atLeast = (min: number) => z.number().transform((n) => Math.max(min, Math.round(n)))

const healthThresholds = z.object({
  ...(Object.fromEntries(
    (Object.keys(HEALTH_THRESHOLD_RANGES) as (keyof typeof HEALTH_THRESHOLD_RANGES)[]).map((k) => [k, clamped(HEALTH_THRESHOLD_RANGES[k], DEFAULT_HEALTH_THRESHOLDS[k])])
  ) as { [K in keyof typeof HEALTH_THRESHOLD_RANGES]: ReturnType<typeof clamped> }),
  silentServicesDegrade: z.boolean().default(DEFAULT_HEALTH_THRESHOLDS.silentServicesDegrade)
})

const healthEnvironment = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  apmEnvironments: z.array(z.string()).default([]),
  k8sIndexSuffix: z.string().default(''),
  hasKubeState: z.boolean().default(false),
  apm: z.object({ errors: z.string().default(''), traces: z.string().default(''), metrics: z.string().default('') }).default({ errors: '', traces: '', metrics: '' }),
  kibanaUrl: z.string().default(''),
  thresholds: healthThresholds.default(DEFAULT_HEALTH_THRESHOLDS as HealthThresholds)
})

/** A number kept inside a range without rounding (thresholds such as 1.5 standard deviations). */
const within = (range: readonly [number, number]) => z.number().transform((n) => Math.min(range[1], Math.max(range[0], n)))

const alertThresholds = z.object(
  Object.fromEntries((Object.keys(METRIC_ALERT_THRESHOLD_RANGES) as (keyof AlertThresholds)[]).map((k) => [k, within(METRIC_ALERT_THRESHOLD_RANGES[k]).default(DEFAULT_METRIC_ALERT_THRESHOLDS[k])])) as {
    [K in keyof AlertThresholds]: z.ZodDefault<ReturnType<typeof within>>
  }
)

const metricRuleOverride = z.object({
  ...(Object.fromEntries((Object.keys(METRIC_ALERT_THRESHOLD_RANGES) as (keyof AlertThresholds)[]).map((k) => [k, within(METRIC_ALERT_THRESHOLD_RANGES[k]).optional()])) as {
    [K in keyof AlertThresholds]: z.ZodOptional<ReturnType<typeof within>>
  }),
  critical: z.boolean().optional(),
  muted: z.boolean().optional()
})

// Optional with defaults on every field, so it needs no config version bump: an older file simply has none.
const alertRules = z.object({
  thresholds: alertThresholds.default(DEFAULT_METRIC_ALERT_THRESHOLDS),
  businessDays: z.array(z.number().int().min(0).max(6)).max(7).default([...DEFAULT_BUSINESS_DAYS]),
  notifyMinSeverity: z.enum(ALERT_SEVERITIES).default('high'),
  overrides: z.record(z.string().trim().min(1).max(200), metricRuleOverride).default({})
})

// Health alerts per kind (Settings → Alerts). Every field optional or defaulted: no version bump.
const healthAlertKind = (kind: (typeof HEALTH_ALERT_KINDS)[number]) => {
  const spec = HEALTH_ALERT_THRESHOLDS[kind]
  return z
    .object({
      notify: z.boolean().default(true),
      // A kind without a tunable threshold drops one written by hand instead of refusing the file.
      threshold: spec ? within(spec.range).optional() : z.unknown().transform((): undefined => undefined),
      channels: z.array(z.enum(HEALTH_ALERT_CHANNELS)).max(HEALTH_ALERT_CHANNELS.length).transform((list) => [...new Set(list)]).optional()
    })
    .optional()
}
const healthAlerts = z.object(Object.fromEntries(HEALTH_ALERT_KINDS.map((k) => [k, healthAlertKind(k)])) as Record<(typeof HEALTH_ALERT_KINDS)[number], ReturnType<typeof healthAlertKind>>)

const healthSettings = z.object({
  refreshMinutes: clamped([MIN_HEALTH_REFRESH_MINUTES, MAX_HEALTH_REFRESH_MINUTES], DEFAULT_HEALTH_REFRESH_MINUTES),
  environments: z.array(healthEnvironment).default([]),
  alertRules: alertRules.optional(),
  alerts: healthAlerts.optional()
})

/** An hour of the day for quiet hours: 0 to 23 (24 reads as 0). */
const dayHour = z.number().transform((n) => ((Math.round(n) % 24) + 24) % 24)
// Optional, so it needs no config version bump.
const profileAlerts = z.object({
  quietHours: z.object({ startHour: dayHour, endHour: dayHour }).nullable().default(null)
})

const modules = z.object(
  Object.fromEntries(OPTIONAL_MODULES.map((m) => [m, z.boolean().default(false)])) as Record<
    (typeof OPTIONAL_MODULES)[number],
    z.ZodDefault<z.ZodBoolean>
  >
)

// Optional with defaults on every field, so it needs no config version bump: an older file simply has none.
const aiReview = z.object({
  enabled: z.boolean().default(AI_REVIEW.enabled),
  auto: z.boolean().default(AI_REVIEW.auto),
  reviewerAgent: z.string().min(1).nullable().default(AI_REVIEW.reviewerAgent),
  baseBranch: z.string().trim().min(1).default(AI_REVIEW.baseBranch),
  maxRounds: clamped([MIN_REVIEW_ROUNDS, MAX_REVIEW_ROUNDS], AI_REVIEW.maxRounds),
  checklist: z.string().max(20_000).default(AI_REVIEW.checklist),
  idleSeconds: clamped([MIN_REVIEW_IDLE_SECONDS, MAX_REVIEW_IDLE_SECONDS], AI_REVIEW.idleSeconds),
  language: z.enum(REVIEW_LANGUAGES).default(AI_REVIEW.language),
  reviewerModel: z.string().trim().max(200).default(AI_REVIEW.reviewerModel),
  reviewerEffort: z.string().trim().max(40).default(AI_REVIEW.reviewerEffort),
  reviewerSession: z.enum(REVIEWER_SESSION_MODES).default(AI_REVIEW.reviewerSession),
  briefPrompt: z.string().max(20_000).default(AI_REVIEW.briefPrompt),
  approveFindings: z.boolean().default(AI_REVIEW.approveFindings)
})

// Plan module (optional, per profile). Every field defaults, so an older profile simply has none.
const meetingRule = z.object({
  id: z.string().trim().min(1).max(64),
  name: z.string().max(200).default(''),
  enabled: z.boolean().default(true),
  match: z
    .object({
      titleContains: z.array(z.string().max(200)).max(50).optional(),
      titleRegex: z.string().max(500).optional(),
      attendeeEmails: z.array(z.string().max(320)).max(200).optional(),
      minAttendees: z.number().int().min(0).max(1000).optional(),
      recurringOnly: z.boolean().optional()
    })
    .default({}),
  action: z.enum(['remind', 'brief']),
  leadMinutes: clamped([0, MAX_LEAD_MINUTES], DEFAULT_REMINDER_LEAD_MINUTES),
  message: z.string().max(500).optional(),
  automationId: z.string().min(1).max(200).optional()
})

const person = z.object({
  id: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(200),
  emails: z.array(z.string().trim().max(320)).max(20).default([]),
  handles: z
    .object({ github: z.string().max(200).optional(), jira: z.string().max(200).optional(), linear: z.string().max(200).optional(), slack: z.string().max(200).optional() })
    .optional(),
  notes: z.string().max(5000).optional()
})

const inboxSettings = z.object({
  areas: z.array(z.string().trim().min(1).max(100)).max(INBOX_LIMITS.areas).default([]),
  criticalities: z
    .array(z.object({ name: z.string().trim().min(1).max(100), priority: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]) }))
    .max(INBOX_LIMITS.criticalities)
    .default([]),
  trackerConnectionId: z.string().max(200).default(''),
  project: z.string().trim().max(100).default(''),
  issueTypes: z.object({ task: z.string().trim().max(100).default(''), bug: z.string().trim().max(100).default('') }).default({ task: '', bug: '' }),
  descriptionTemplate: z.string().max(20_000).default('')
})

const planner = z.object({
  calendarIds: z.array(id).max(20).default([]),
  refreshMinutes: clamped([MIN_PLANNER_REFRESH_MINUTES, MAX_PLANNER_REFRESH_MINUTES], DEFAULT_PLANNER_REFRESH_MINUTES),
  reminderLeadMinutes: clamped([0, MAX_LEAD_MINUTES], DEFAULT_REMINDER_LEAD_MINUTES),
  rules: z.array(meetingRule).max(100).default([]),
  briefTemplate: z.string().max(20_000).default(''),
  people: z.array(person).max(500).default([]),
  inbox: inboxSettings.optional(),
  // Unset means DEFAULT_MILESTONE_MARGIN (see the Plan service).
  milestoneMargin: z
    .number()
    .transform((n) => Math.min(MILESTONE_MARGIN_RANGE[1], Math.max(MILESTONE_MARGIN_RANGE[0], Math.round(n))))
    .optional(),
  // Unset means DEFAULT_AGENT_MILESTONE_MODE (`ask`).
  agentMilestones: z.enum(AGENT_MILESTONE_MODES).optional()
})

const folderOptions = z.object({ onlyGitRepos: z.boolean().optional(), subfoldersAreProjects: z.boolean().optional(), worktrees: z.boolean().optional() })

// Optional with defaults on every field, so it needs no config version bump: an older file simply has none.
const worktrees = z.object({
  enabled: z.boolean().default(DEFAULT_WORKTREE_SETTINGS.enabled),
  location: z.string().trim().max(1000).default(DEFAULT_WORKTREE_SETTINGS.location),
  branchPrefix: z.string().trim().max(100).default(DEFAULT_WORKTREE_SETTINGS.branchPrefix),
  baseRef: z.string().trim().max(200).default(DEFAULT_WORKTREE_SETTINGS.baseRef),
  onClose: z.enum(WORKTREE_CLOSE_MODES).default(DEFAULT_WORKTREE_SETTINGS.onClose)
})

const profile = z.object({
  id,
  name: z.string().min(1),
  connections: z.partialRecord(z.enum(CONNECTION_KINDS), id).default({}),
  accountIds: z.array(id).default([]),
  agentIds: z.array(id).optional(),
  preferredAgents: z.array(z.string().min(1)).optional(),
  modules: modules.default({ flows: false, health: false, chatWatcher: false, automations: false, flowMaps: false, planner: false }),
  folders: z.array(z.string().min(1)).optional(),
  defaultFolder: z.string().trim().min(1).optional(),
  folderOptions: z.record(z.string().min(1), folderOptions).optional(),
  symbol: z.string().trim().min(1).max(40).optional(),
  linkBrowser: z.string().trim().min(1).max(200).optional(),
  linkCommand: z.string().trim().min(1).max(500).optional(),
  linkChromeProfile: z.string().trim().regex(CHROME_PROFILE_DIR).optional(),
  ownsOutside: z.boolean().optional(),
  envNames: z.array(z.string().regex(ENV_NAME)).optional(),
  health: healthSettings.optional(),
  slackArchiveMinutes: z.number().int().min(1).optional(),
  aiReview: aiReview.optional(),
  worktrees: worktrees.optional(),
  accountFailover: z.enum(['ask', 'automatic', 'off']).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  planner: planner.optional(),
  alerts: profileAlerts.optional()
})

const groupMember = z.object({
  key: z.string().min(1),
  title: z.string(),
  agentKey: z.string().min(1),
  cwd: z.string(),
  profileId: z.string().min(1).optional(),
  // What a closed row shows; optional, so older files load unchanged (no version bump).
  titled: z.boolean().optional(),
  agentId: z.string().min(1).optional(),
  agentName: z.string().optional(),
  accountId: z.string().min(1).optional(),
  accountName: z.string().optional(),
  lookedUp: z.boolean().optional()
})

const sessionGroups = z.object({
  groups: z
    .array(z.object({ id: z.string().min(1), name: z.string(), collapsed: z.boolean().default(false), members: z.array(groupMember).default([]) }))
    .default([]),
  top: z
    .array(z.discriminatedUnion('kind', [z.object({ kind: z.literal('group'), id: z.string().min(1) }), z.object({ kind: z.literal('session'), key: z.string().min(1) })]))
    .default([])
})

/** A usage percentage, kept within 0..100 (not rounded). */
const share = z.number().transform((n) => Math.min(100, Math.max(0, n)))
const hour = z.number().transform((n) => Math.min(24, Math.max(0, Math.round(n))))
const weekdays = z.array(z.number().int().min(0).max(6))

const chatWatcher = z.object({
  enabled: z.boolean().default(false),
  accountId: id.nullable().default(null),
  model: z.string().default('haiku'),
  intervalMinutes: atLeast(1).default(10),
  startHour: hour.default(9),
  endHour: hour.default(19),
  weekdays: weekdays.default([1, 2, 3, 4, 5]),
  usageThreshold: share.default(85),
  channels: z.array(z.object({ id: z.string().min(1), name: z.string(), purpose: z.string().default('') })).default([])
})

const automation = z.object({
  id: z.string().min(1),
  name: z.string(),
  enabled: z.boolean().default(true),
  prompt: z.string().default(''),
  profileId: id.nullable().default(null),
  agentKey: z.string().min(1),
  folder: z.string().default('~'),
  view: z.enum(['app', 'console']).default('app'),
  model: z.string().optional(),
  effort: z.string().optional(),
  permissionMode: z.string().optional(),
  triggers: z
    .object({
      chatChannelIds: z.array(z.string()).default([]),
      prOwner: z.string().default(''),
      intervalMinutes: atLeast(1).nullable().default(null),
      pendingGate: z.object({ kind: z.literal('prReviewQueue'), stateFile: z.string() }).optional()
    })
    .default({ chatChannelIds: [], prOwner: '', intervalMinutes: null }),
  window: z.object({ days: weekdays, startHour: hour, endHour: hour }).default({ days: [1, 2, 3, 4, 5], startHour: 9, endHour: 19 }),
  limits: z
    .object({ maxRuns: atLeast(1), perMinutes: atLeast(1), maxPerDay: atLeast(1).nullable() })
    .default({ maxRuns: 6, perMinutes: 5, maxPerDay: 60 }),
  usageThreshold: share.default(85),
  sessionPolicy: z.enum(['reuse', 'newEachRun']).default('reuse'),
  clearContext: z.boolean().optional(),
  runTimeoutMinutes: atLeast(1).default(30),
  receivesChatReplies: z.boolean().default(true),
  notify: z.enum(['failures', 'always', 'never']).default('failures')
})

/** A percentage from the config: rounded and clamped into 1..100 (a hand-edited value never keeps the config from loading). */
const percent = z.number().transform((n) => Math.min(100, Math.max(1, Math.round(n))))

const usageBudget = z.object({
  alerts: z.boolean().default(DEFAULT_USAGE_BUDGET.alerts),
  thresholds: z
    .array(percent)
    .transform((list) => [...new Set(list)].sort((a, b) => a - b))
    .default([...DEFAULT_USAGE_BUDGET.thresholds]),
  warnMargin: z
    .number()
    .transform((n) => Math.min(50, Math.max(0, Math.round(n))))
    .default(DEFAULT_USAGE_BUDGET.warnMargin),
  ceilings: z.record(z.string(), z.record(z.string(), percent)).default({})
})

const popoverBlock = (key: keyof TrayPopoverOptions) => z.boolean().default(DEFAULT_TRAY_POPOVER_OPTIONS[key] as boolean).catch(DEFAULT_TRAY_POPOVER_OPTIONS[key] as boolean)
const trayPopoverOptions = z.object({
  meetings: popoverBlock('meetings'),
  meetingCount: z
    .union([z.literal(1), z.literal(2), z.literal(3)])
    .default(DEFAULT_TRAY_POPOVER_OPTIONS.meetingCount)
    .catch(DEFAULT_TRAY_POPOVER_OPTIONS.meetingCount),
  plan: popoverBlock('plan'),
  pullRequests: popoverBlock('pullRequests'),
  health: popoverBlock('health'),
  usage: popoverBlock('usage'),
  recent: popoverBlock('recent')
})

export const configSchema = z.object({
  version: z.literal(CONFIG_VERSION),
  connections: z.array(connection).default([]),
  agents: z.array(agent).default([]),
  accounts: z.array(account).default([]),
  profiles: z.array(profile).default([]),
  activeProfileId: id.optional(),
  options: z
    .object({
      claudePlanUsage: z.boolean().default(false),
      notifyReplied: z.boolean().default(true),
      notifyNeedsAnswer: z.boolean().default(true),
      notifyError: z.boolean().default(true),
      checkForUpdates: z.boolean().default(false),
      notifyPrEvents: z
        .object(Object.fromEntries(PR_EVENT_KINDS.map((k) => [k, z.boolean().default(DEFAULT_PR_EVENT_TOGGLES[k])])) as Record<(typeof PR_EVENT_KINDS)[number], z.ZodDefault<z.ZodBoolean>>)
        .default(DEFAULT_PR_EVENT_TOGGLES),
      codexUsage: z.boolean().default(false),
      kiroUsage: z.boolean().default(true),
      usageBudget: usageBudget.default(DEFAULT_USAGE_BUDGET).catch(DEFAULT_USAGE_BUDGET),
      notifySlack: z.boolean().default(true),
      notifyAutomations: z.boolean().default(true),
      notifyTickets: z.boolean().default(true),
      notifyHealth: z.boolean().default(true),
      notifyFlowMaps: z.boolean().default(true),
      notifyMeetings: z.boolean().default(true),
      notifyMetricAlerts: z.boolean().default(true),
      healthRefreshFloorMinutes: z
        .number()
        .int()
        .refine((n) => (HEALTH_FLOOR_CHOICES as readonly number[]).includes(n))
        .default(DEFAULT_HEALTH_FLOOR_MINUTES)
        .catch(DEFAULT_HEALTH_FLOOR_MINUTES),
      keepInTray: z.boolean().default(true),
      reopenSessions: z.boolean().default(true),
      showAppBadge: z.boolean().default(true),
      trayPopover: trayPopoverOptions.default(DEFAULT_TRAY_POPOVER_OPTIONS).catch(DEFAULT_TRAY_POPOVER_OPTIONS),
      notificationsEnabled: z.boolean().default(true),
      readAloud: z.boolean().default(false),
      speechVoice: z.string().max(200).default(''),
      speechRate: clamped(SPEECH_RATE_RANGE, DEFAULT_SPEECH_RATE),
      listenModel: z.string().trim().max(100).regex(/^[\w.:@\-[\]]*$/).default(DEFAULT_LISTEN_MODEL),
      welcomeDone: z.boolean().default(false),
      protectedBranches: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
      notificationsPausedUntil: z.number().int().nonnegative().optional(),
      agentDefaultModes: z.record(z.string().min(1).max(64), z.string().trim().min(1).max(200)).optional()
    })
    .optional(),
  sessionGroups: sessionGroups.optional(),
  chatWatcher: chatWatcher.optional(),
  automations: z.array(automation).optional()
})

// Compile-time guard: the schema output must stay assignable to the domain types.
type Parsed = z.output<typeof configSchema>
const _schemaMatchesDomain = (p: Parsed): WorkhubConfig => p
void _schemaMatchesDomain
