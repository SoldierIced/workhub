// Types of the preload bridge (window.hub), shared by main, preload and renderer.
import type {
  AgentCapabilities,
  AgentDefinition,
  AgentEvent,
  AgentAccount,
  Connection,
  ConnectionProvider,
  EffectiveAgent,
  Profile,
  Result,
  SecretChange,
  Session,
  SessionScreen,
  ValidationIssue,
  WorkhubConfig
} from '@workhub/core'
import type { CodeHostApi } from './codehost-api'

export interface ConfigSnapshot {
  config: WorkhubConfig
  /** Problems already in the stored config (e.g. a hand-edited file). */
  issues: ValidationIssue[]
  agents: AgentDefinition[]
  providers: ConnectionProvider[]
  /** Connection ids that have a stored secret. */
  connectionsWithSecret: string[]
  /** Where the config and secrets files live. */
  dataDir: string
  /** Set when the config file could not be loaded; editing is disabled until it is fixed. */
  loadError?: string
}

export interface ConfigApi {
  get(): Promise<ConfigSnapshot>
  saveConnection(connection: Connection, secret: SecretChange): Promise<Result<WorkhubConfig>>
  deleteConnection(id: string): Promise<Result<WorkhubConfig>>
  saveAccount(account: AgentAccount): Promise<Result<WorkhubConfig>>
  deleteAccount(id: string): Promise<Result<WorkhubConfig>>
  saveProfile(profile: Profile): Promise<Result<WorkhubConfig>>
  deleteProfile(id: string): Promise<Result<WorkhubConfig>>
  setActiveProfile(id: string): Promise<Result<WorkhubConfig>>
  effectiveAgents(profileId: string | null): Promise<EffectiveAgent[]>
}

/** A session as the renderer sees it. */
export interface SessionView extends Session {
  label: string
  agentName: string
  adapter: AgentDefinition['adapter']
  capabilities: AgentCapabilities
  screens: SessionScreen[]
}

export interface StartSessionInput {
  profileId: string | null
  agentKey: string
  cwd: string
  cols?: number
  rows?: number
}

export interface SessionsApi {
  list(): Promise<SessionView[]>
  /** Returns at once with the session in `starting`; progress arrives through onChanged. */
  start(input: StartSessionInput): Promise<SessionView>
  prompt(id: string, text: string): Promise<string>
  cancel(id: string): Promise<void>
  stop(id: string): Promise<void>
  respondPermission(id: string, requestId: string, optionId: string | null): void
  write(id: string, data: string): void
  resize(id: string, cols: number, rows: number): void
  onEvent(cb: (e: AgentEvent) => void): () => void
  onChanged(cb: (s: SessionView) => void): () => void
}

/** The OS family the app runs on; the renderer uses it for shortcut labels and window chrome. */
export type Platform = 'mac' | 'windows' | 'linux'

export function toPlatform(nodePlatform: string): Platform {
  return nodePlatform === 'darwin' ? 'mac' : nodePlatform === 'win32' ? 'windows' : 'linux'
}

/** Appearance preference: follow the OS or force one theme. */
export type ThemePreference = 'system' | 'light' | 'dark'

export interface HubApi {
  platform: Platform
  /** Tells the main process the theme preference so native chrome (title bar, dialogs) follows it. */
  setTheme(theme: ThemePreference): void
  getDefaultCwd(): Promise<string>
  pickFolder(): Promise<string | null>
  config: ConfigApi
  sessions: SessionsApi
  codeHost: CodeHostApi
}
