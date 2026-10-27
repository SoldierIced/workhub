import { z } from 'zod'
import type { AgentAccount, AgentDefinition } from '../domain/agent'
import { CONNECTION_KINDS, type Connection } from '../domain/connection'
import { OPTIONAL_MODULES, type Profile } from '../domain/profile'
import type { SessionGroups } from '../domain/session-groups'
import { DEFAULT_HEALTH_REFRESH_MINUTES, DEFAULT_HEALTH_THRESHOLDS, HEALTH_THRESHOLD_RANGES, MAX_HEALTH_REFRESH_MINUTES, MIN_HEALTH_REFRESH_MINUTES, type HealthThresholds } from '../health/types'
import { DEFAULT_PR_EVENT_TOGGLES, PR_EVENT_KINDS, type PrEventToggles } from '../pr-events/types'
import type { ChatWatcherSettings } from '../chat/types'
import type { AutomationDefinition } from '../automations/types'
import { DEFAULT_AI_REVIEW_SETTINGS as AI_REVIEW, MAX_REVIEW_IDLE_SECONDS, MAX_REVIEW_ROUNDS, MIN_REVIEW_IDLE_SECONDS, MIN_REVIEW_ROUNDS } from '../ai-review/defaults'
import { REVIEW_LANGUAGES } from '../ai-review/types'
import { DEFAULT_USAGE_BUDGET, type UsageBudgetOptions } from '../usage/budget'

/**
 * The persisted config. Every change to its shape bumps `CONFIG_VERSION` and adds a migration
 * in `migrations.ts`. Secrets are never part of it (only `secretRef` keys).
 */
export const CONFIG_VERSION = 6

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
   * (Kiro's sign-in, never read by Workhub). Off by default: each read starts Kiro briefly.
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
  /** OS notification when a Health environment degrades, becomes unreachable or recovers. */
  notifyHealth: boolean
  /** Closing the main window keeps the app running in the menu bar / notification area. */
  keepInTray: boolean
  /** "Pause notifications": nothing is shown until this moment (epoch ms). Unset when not paused. */
  notificationsPausedUntil?: number
}

export const DEFAULT_OPTIONS: AppOptions = { claudePlanUsage: false, notifyReplied: true, notifyNeedsAnswer: true, notifyError: true, checkForUpdates: false, notifyPrEvents: DEFAULT_PR_EVENT_TOGGLES, codexUsage: false, kiroUsage: false, usageBudget: DEFAULT_USAGE_BUDGET, notifySlack: true, notifyAutomations: true, notifyTickets: true, notifyHealth: true, keepInTray: true }

export function appOptions(config: Pick<WorkhubConfig, 'options'>): AppOptions {
  return { ...DEFAULT_OPTIONS, ...config.options }
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
  imageInput: z.boolean().default(false)
})

const consoleLaunch = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  resumeArgs: z.array(z.string()).optional(),
  newSessionArgs: z.array(z.string()).optional()
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

const healthSettings = z.object({
  refreshMinutes: clamped([MIN_HEALTH_REFRESH_MINUTES, MAX_HEALTH_REFRESH_MINUTES], DEFAULT_HEALTH_REFRESH_MINUTES),
  environments: z.array(healthEnvironment).default([])
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
  reviewerModel: z.string().trim().max(200).default(AI_REVIEW.reviewerModel)
})

const profile = z.object({
  id,
  name: z.string().min(1),
  connections: z.partialRecord(z.enum(CONNECTION_KINDS), id).default({}),
  accountIds: z.array(id).default([]),
  agentIds: z.array(id).optional(),
  preferredAgents: z.array(z.string().min(1)).optional(),
  modules: modules.default({ flows: false, health: false, chatWatcher: false, automations: false }),
  folders: z.array(z.string().min(1)).optional(),
  health: healthSettings.optional(),
  slackArchiveMinutes: z.number().int().min(1).optional(),
  aiReview: aiReview.optional(),
  accountFailover: z.enum(['ask', 'automatic', 'off']).optional()
})

const groupMember = z.object({ key: z.string().min(1), title: z.string(), agentKey: z.string().min(1), cwd: z.string() })

const sessionGroups = z.object({
  groups: z
    .array(z.object({ id: z.string().min(1), name: z.string(), collapsed: z.boolean().default(false), members: z.array(groupMember).default([]) }))
    .default([]),
  top: z
    .array(z.discriminatedUnion('kind', [z.object({ kind: z.literal('group'), id: z.string().min(1) }), z.object({ kind: z.literal('session'), key: z.string().min(1) })]))
    .default([])
})

const hour = z.number().int().min(0).max(24)
const weekdays = z.array(z.number().int().min(0).max(6))

const chatWatcher = z.object({
  enabled: z.boolean().default(false),
  accountId: id.nullable().default(null),
  model: z.string().default('haiku'),
  intervalMinutes: z.number().int().min(1).default(10),
  startHour: hour.default(9),
  endHour: hour.default(19),
  weekdays: weekdays.default([1, 2, 3, 4, 5]),
  usageThreshold: z.number().min(0).max(100).default(85),
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
  triggers: z
    .object({
      chatChannelIds: z.array(z.string()).default([]),
      prOwner: z.string().default(''),
      intervalMinutes: z.number().int().min(1).nullable().default(null),
      pendingGate: z.object({ kind: z.literal('prReviewQueue'), stateFile: z.string() }).optional()
    })
    .default({ chatChannelIds: [], prOwner: '', intervalMinutes: null }),
  window: z.object({ days: weekdays, startHour: hour, endHour: hour }).default({ days: [1, 2, 3, 4, 5], startHour: 9, endHour: 19 }),
  limits: z
    .object({ maxRuns: z.number().int().min(1), perMinutes: z.number().int().min(1), maxPerDay: z.number().int().min(1).nullable() })
    .default({ maxRuns: 6, perMinutes: 5, maxPerDay: 60 }),
  usageThreshold: z.number().min(0).max(100).default(85),
  sessionPolicy: z.enum(['reuse', 'newEachRun']).default('reuse'),
  runTimeoutMinutes: z.number().int().min(1).default(30),
  receivesChatReplies: z.boolean().default(true)
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
      kiroUsage: z.boolean().default(false),
      usageBudget: usageBudget.default(DEFAULT_USAGE_BUDGET).catch(DEFAULT_USAGE_BUDGET),
      notifySlack: z.boolean().default(true),
      notifyAutomations: z.boolean().default(true),
      notifyTickets: z.boolean().default(true),
      notifyHealth: z.boolean().default(true),
      keepInTray: z.boolean().default(true),
      notificationsPausedUntil: z.number().int().nonnegative().optional()
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
