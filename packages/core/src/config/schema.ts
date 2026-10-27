import { z } from 'zod'
import type { AgentAccount, AgentDefinition } from '../domain/agent'
import { CONNECTION_KINDS, type Connection } from '../domain/connection'
import { OPTIONAL_MODULES, type Profile } from '../domain/profile'
import type { SessionGroups } from '../domain/session-groups'
import { DEFAULT_HEALTH_REFRESH_MINUTES, DEFAULT_HEALTH_THRESHOLDS, HEALTH_THRESHOLD_RANGES, MAX_HEALTH_REFRESH_MINUTES, MIN_HEALTH_REFRESH_MINUTES, type HealthThresholds } from '../health/types'
import { DEFAULT_PR_EVENT_TOGGLES, PR_EVENT_KINDS, type PrEventToggles } from '../pr-events/types'

/**
 * The persisted config. Every change to its shape bumps `CONFIG_VERSION` and adds a migration
 * in `migrations.ts`. Secrets are never part of it (only `secretRef` keys).
 */
export const CONFIG_VERSION = 4

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
  /** OS notification per kind of pull request event (Settings → Notifications). */
  notifyPrEvents: PrEventToggles
}

export const DEFAULT_OPTIONS: AppOptions = { claudePlanUsage: false, notifyReplied: true, notifyNeedsAnswer: true, notifyError: true, notifyPrEvents: DEFAULT_PR_EVENT_TOGGLES }

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
  env: stringMap.optional()
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

const profile = z.object({
  id,
  name: z.string().min(1),
  connections: z.partialRecord(z.enum(CONNECTION_KINDS), id).default({}),
  accountIds: z.array(id).default([]),
  agentIds: z.array(id).optional(),
  modules: modules.default({ flows: false, health: false, chatWatcher: false, automations: false }),
  folders: z.array(z.string().min(1)).optional(),
  health: healthSettings.optional()
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
      notifyPrEvents: z
        .object(Object.fromEntries(PR_EVENT_KINDS.map((k) => [k, z.boolean().default(DEFAULT_PR_EVENT_TOGGLES[k])])) as Record<(typeof PR_EVENT_KINDS)[number], z.ZodDefault<z.ZodBoolean>>)
        .default(DEFAULT_PR_EVENT_TOGGLES)
    })
    .optional(),
  sessionGroups: sessionGroups.optional()
})

// Compile-time guard: the schema output must stay assignable to the domain types.
type Parsed = z.output<typeof configSchema>
const _schemaMatchesDomain = (p: Parsed): WorkhubConfig => p
void _schemaMatchesDomain
