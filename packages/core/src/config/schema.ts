import { z } from 'zod'
import type { AgentAccount, AgentDefinition } from '../domain/agent'
import { CONNECTION_KINDS, type Connection } from '../domain/connection'
import { OPTIONAL_MODULES, type Profile } from '../domain/profile'

/**
 * The persisted config. Every change to its shape bumps `CONFIG_VERSION` and adds a migration
 * in `migrations.ts`. Secrets are never part of it (only `secretRef` keys).
 */
export const CONFIG_VERSION = 2

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
}

export interface AppOptions {
  /**
   * Read Claude plan usage (5 h and weekly windows) from Anthropic's undocumented OAuth usage
   * endpoint with each account's own Claude Code login, as Workhub 1 does. Off by default
   * (PLAN section 6): the endpoint is not a public API and may change or be refused.
   */
  claudePlanUsage: boolean
}

export const DEFAULT_OPTIONS: AppOptions = { claudePlanUsage: false }

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
  folders: z.array(z.string().min(1)).optional()
})

export const configSchema = z.object({
  version: z.literal(CONFIG_VERSION),
  connections: z.array(connection).default([]),
  agents: z.array(agent).default([]),
  accounts: z.array(account).default([]),
  profiles: z.array(profile).default([]),
  activeProfileId: id.optional(),
  options: z.object({ claudePlanUsage: z.boolean().default(false) }).optional()
})

// Compile-time guard: the schema output must stay assignable to the domain types.
type Parsed = z.output<typeof configSchema>
const _schemaMatchesDomain = (p: Parsed): WorkhubConfig => p
void _schemaMatchesDomain
