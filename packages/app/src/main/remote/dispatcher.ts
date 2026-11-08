import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import type { RemoteCapability } from '../../shared/remote-api'
import { isUnattendedMode, type EffectiveAgent, type Profile, type WorkhubConfig } from '@workhub/core'
import type { ConfigSnapshot, SessionView, StartSessionInput } from '../../shared/api'
import type { HandlerTable } from './ipc-recorder'
import { REMOTE_EVENTS, REMOTE_INVOKES, REMOTE_MESSAGES, remoteAllows } from './allowlist'

/** A paired device while it is connected: who it is, what it was granted, and how events reach it. */
export interface RemoteDevice {
  id: string
  capabilities: ReadonlySet<RemoteCapability>
  /** Delivers an event the device subscribed to (the same channel and arguments a window gets). */
  emit(channel: string, args: unknown[]): void
}

export interface RemoteHubDeps {
  handlers: HandlerTable
  /** The folders the profile lists (hub:profileFolders), the only ones a device may open a session in. */
  profileFolders(profileId: string | null): Promise<string[]>
  log?: { warn(line: string): void }
  /** The clock rate limits run on (tests pass their own). */
  now?: () => number
}

/** Per device: any call or message, as a token bucket (capacity, refilled over the window). */
export const REMOTE_RATE = { calls: 600, windowMs: 10_000 }
/** Per device: calls still waiting for their handler. */
export const REMOTE_MAX_IN_FLIGHT = 32
/** Per device: calls that start an agent on the desktop, on a budget of their own. */
export const REMOTE_COSTLY_RATE = { calls: 10, windowMs: 60_000 }
const COSTLY_CHANNELS: ReadonlySet<string> = new Set(['sessions:start', 'sessions:reopen', 'plan:brief', 'automations:runNow'])
const MCP_ACTIONS: ReadonlySet<unknown> = new Set(['refresh', 'reconnect', 'enable', 'disable'])

/** What a device sees when a handler fails for a reason other than a refusal; the real error goes to the log. */
export const REMOTE_GENERIC_ERROR = 'the desktop could not complete the request'

/**
 * Mode ids a device may never ask for: the ones Workhub treats as unattended (bypass, yolo,
 * full access) plus `auto` (Claude decides itself; Codex approves inside the workspace).
 */
const FORBIDDEN_MODES: ReadonlySet<string> = new Set(['auto', 'bypasspermissions', 'yolo', 'full-auto', 'full-access', 'dangerously-skip-permissions'])

export function isRemoteForbiddenMode(id: string): boolean {
  return isUnattendedMode(id) || FORBIDDEN_MODES.has(id.toLowerCase())
}

/**
 * Strings a device passes that can end up in an agent's argv (model, effort, mode, session ids,
 * branch names): plain tokens, never an option.
 */
const ARG_TOKEN = /^[A-Za-z0-9._:/-]{1,128}$/

function checkToken(value: unknown, what: string, opts: { allowEmpty?: boolean } = {}): void {
  if (value === undefined || value === null) return
  if (typeof value !== 'string') throw new RemoteRefused(`${what} must be text`)
  if (value === '' && opts.allowEmpty) return
  if (!ARG_TOKEN.test(value) || value.startsWith('-')) throw new RemoteRefused(`${what} is not valid`)
}

class TokenBucket {
  private tokens: number
  private last: number
  constructor(private readonly capacity: number, private readonly windowMs: number, now: number) {
    this.tokens = capacity
    this.last = now
  }

  take(now: number): boolean {
    const elapsed = Math.max(0, now - this.last)
    this.last = now
    this.tokens = Math.min(this.capacity, this.tokens + (elapsed * this.capacity) / this.windowMs)
    if (this.tokens < 1) return false
    this.tokens -= 1
    return true
  }
}

interface DeviceLimits {
  calls: TokenBucket
  costly: TokenBucket
  inFlight: number
}

/** Why a call was refused; the device sees the message, never the handler's existence. */
export class RemoteRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RemoteRefused'
  }
}

/** Sender ids a window can never have, so prompt tokens of a device never collide with a window's. */
const FIRST_REMOTE_SENDER_ID = 1_000_000

/**
 * Routes a paired device's `hub` calls to the handlers the app registered for its own windows, and
 * fans main's events out to the devices whose capabilities cover them. The transport (the relay,
 * end-to-end encryption, pairing) lives elsewhere: this only knows devices and channels.
 */
export class RemoteHub {
  private readonly devices = new Map<string, { device: RemoteDevice; senderId: number }>()
  private nextSenderId = FIRST_REMOTE_SENDER_ID
  /** By device id; kept across reconnects so a reconnect does not refill the budget. */
  private readonly limits = new Map<string, DeviceLimits>()

  constructor(private readonly deps: RemoteHubDeps) {}

  /** Registers a connected device; the returned function forgets it (events stop). */
  attach(device: RemoteDevice): () => void {
    this.devices.set(device.id, { device, senderId: this.nextSenderId++ })
    return () => {
      const current = this.devices.get(device.id)
      if (current?.device === device) this.devices.delete(device.id)
    }
  }

  connected(): string[] {
    return [...this.devices.keys()]
  }

  /** A request/response call (`ipcRenderer.invoke`) from a device. */
  async invoke(deviceId: string, channel: string, args: unknown[]): Promise<unknown> {
    const entry = this.devices.get(deviceId)
    if (!entry) throw new RemoteRefused('the device is not connected')
    if (!remoteAllows(REMOTE_INVOKES, channel, entry.device.capabilities)) throw this.refuse(deviceId, channel)
    const handler = this.deps.handlers.invoke(channel)
    if (!handler) throw this.refuse(deviceId, channel)
    const limits = this.limitsOf(deviceId)
    this.spend(deviceId, channel, limits)
    limits.inFlight++
    try {
      const checked = await this.validate(channel, args)
      // Only a call that passed its checks spends an agent run.
      if (COSTLY_CHANNELS.has(channel) && !limits.costly.take(this.now())) throw this.limited(deviceId, channel, 'too many new agent runs')
      let result: unknown
      try {
        result = await handler(this.event(entry) as IpcMainInvokeEvent, ...checked)
      } catch (err) {
        if (err instanceof RemoteRefused) throw err
        // Handler errors can name local paths: the device gets a sentence, the log the detail.
        this.deps.log?.warn(`remote: ${channel} from ${deviceId} failed: ${err instanceof Error ? err.message : String(err)}`)
        throw new RemoteRefused(REMOTE_GENERIC_ERROR)
      }
      return redactResult(channel, result)
    } finally {
      limits.inFlight--
    }
  }

  /** A one-way message (`ipcRenderer.send`) from a device. */
  message(deviceId: string, channel: string, args: unknown[]): void {
    const entry = this.devices.get(deviceId)
    if (!entry) throw new RemoteRefused('the device is not connected')
    if (!remoteAllows(REMOTE_MESSAGES, channel, entry.device.capabilities)) throw this.refuse(deviceId, channel)
    const handler = this.deps.handlers.message(channel)
    if (!handler) throw this.refuse(deviceId, channel)
    this.spend(deviceId, channel, this.limitsOf(deviceId), false)
    this.validateMessage(channel, args)
    handler(this.event(entry) as IpcMainEvent, ...args)
  }

  /** One-way messages carry plain tokens; `sessions:mcp` takes one of four actions (an unknown one would turn a server off). */
  private validateMessage(channel: string, args: unknown[]): void {
    if (channel === 'sessions:mcp') {
      checkToken(args[0], 'the session id')
      if (!MCP_ACTIONS.has(args[1] as string)) throw new RemoteRefused('that MCP action is not valid')
      checkToken(args[2], 'the server name')
    } else if (channel === 'sessions:permission') {
      checkToken(args[0], 'the session id')
      checkToken(args[1], 'the request id')
    }
  }

  /** Called wherever main sends an event to its windows: the devices that may see it get it too. */
  tap(channel: string, args: unknown[]): void {
    if (!(channel in REMOTE_EVENTS)) return
    for (const { device } of this.devices.values()) {
      if (!remoteAllows(REMOTE_EVENTS, channel, device.capabilities)) continue
      try {
        device.emit(channel, args)
      } catch (err) {
        this.deps.log?.warn(`remote: event ${channel} to ${device.id} failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  private limitsOf(deviceId: string): DeviceLimits {
    let limits = this.limits.get(deviceId)
    if (!limits) {
      const now = this.now()
      limits = { calls: new TokenBucket(REMOTE_RATE.calls, REMOTE_RATE.windowMs, now), costly: new TokenBucket(REMOTE_COSTLY_RATE.calls, REMOTE_COSTLY_RATE.windowMs, now), inFlight: 0 }
      this.limits.set(deviceId, limits)
    }
    return limits
  }

  /** Takes one call from the device's general budget, or refuses it (agent runs are charged in invoke). */
  private spend(deviceId: string, channel: string, limits: DeviceLimits, waits = true): void {
    const now = this.now()
    if (waits && limits.inFlight >= REMOTE_MAX_IN_FLIGHT) throw this.limited(deviceId, channel, 'too many calls at once')
    if (!limits.calls.take(now)) throw this.limited(deviceId, channel, 'too many calls')
  }

  private limited(deviceId: string, channel: string, why: string): RemoteRefused {
    this.deps.log?.warn(`remote: rate limited ${channel} from ${deviceId} (${why})`)
    return new RemoteRefused(`${why}; try again in a moment`)
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  private refuse(deviceId: string, channel: string): RemoteRefused {
    this.deps.log?.warn(`remote: refused ${channel} from ${deviceId}`)
    return new RemoteRefused(`${channel} is not available remotely`)
  }

  /**
   * What a handler sees as the Electron event. `sender` answers like a window of the device's own:
   * what a handler sends back to it (sessions:promptStarted) goes to the device, and its id keys
   * the device's prompt tokens apart from every window's.
   */
  private event(entry: { device: RemoteDevice; senderId: number }): Pick<IpcMainEvent, 'sender'> & { senderFrame: null } {
    const sender = {
      id: entry.senderId,
      isDestroyed: () => !this.devices.has(entry.device.id),
      send: (channel: string, ...args: unknown[]) => entry.device.emit(channel, args)
    }
    return { sender: sender as unknown as IpcMainEvent['sender'], senderFrame: null }
  }

  private async validate(channel: string, args: unknown[]): Promise<unknown[]> {
    switch (channel) {
      case 'sessions:start':
        return [await this.checkedStart(args[0]), ...args.slice(1)]
      case 'sessions:reopen':
        checkToken(args[0], 'the session identity')
        return [args[0], await this.checkedStart(args[1]), ...args.slice(2)]
      case 'sessions:setModel':
        checkToken(args[1], 'the model')
        return args
      case 'sessions:setAgentMode':
        await this.checkModeChange(args[0], args[1])
        return args
      default:
        return args
    }
  }

  /** A session may only start in a folder the profile lists, never a path the device typed, and never in a mode that skips permissions. */
  private async checkedStart(input: unknown): Promise<StartSessionInput> {
    if (!input || typeof input !== 'object') throw new RemoteRefused('a session input is required')
    const start = input as StartSessionInput
    if (typeof start.cwd !== 'string' || !start.cwd) throw new RemoteRefused('a folder is required')
    checkToken(start.model, 'the model')
    checkToken(start.effort, 'the effort')
    checkToken(start.modeId, 'the mode')
    if (typeof start.modeId === 'string' && isRemoteForbiddenMode(start.modeId)) throw new RemoteRefused('that mode is not available remotely')
    checkToken(start.resumeAgentSessionId, 'the session id')
    checkToken(start.identity, 'the session identity')
    if (start.worktree !== undefined && start.worktree !== null) {
      if (typeof start.worktree !== 'object') throw new RemoteRefused('the worktree is not valid')
      checkToken(start.worktree.branch, 'the branch', { allowEmpty: true })
    }
    const profileId = typeof start.profileId === 'string' ? start.profileId : null
    const allowed = await this.deps.profileFolders(profileId)
    if (!allowed.includes(start.cwd)) throw new RemoteRefused('the folder is not one of the profile folders')
    return start
  }

  /** A device may switch a session's mode, but never to one that skips permissions, nor a read-only reviewer's at all. */
  private async checkModeChange(sessionId: unknown, modeId: unknown): Promise<void> {
    if (typeof modeId !== 'string' || !modeId) throw new RemoteRefused('a mode id is required')
    checkToken(modeId, 'the mode')
    if (isRemoteForbiddenMode(modeId)) throw new RemoteRefused('that mode is not available remotely')
    const list = this.deps.handlers.invoke('sessions:list')
    const views = list ? ((await list({} as IpcMainInvokeEvent)) as SessionView[] | undefined) : undefined
    const view = Array.isArray(views) ? views.find((v) => v?.id === sessionId) : undefined
    if (view?.readOnly) throw new RemoteRefused('a read-only session keeps its mode')
  }
}

/** Results that carry what a device has no use for, trimmed. */
function redactResult(channel: string, result: unknown): unknown {
  if (channel === 'config:get' && result && typeof result === 'object') return remoteConfigSnapshot(result as ConfigSnapshot)
  if (channel === 'config:effectiveAgents' && Array.isArray(result)) return (result as EffectiveAgent[]).map(remoteEffectiveAgent)
  return result
}

/**
 * The config as a device sees it: the profiles' names, colors and Plan criticalities and the active
 * profile. Never connections, accounts, agent definitions (env, commands), automations, folders or
 * the data folder; the other keys stay, empty, so the snapshot keeps its shape.
 */
export function remoteConfigSnapshot(snapshot: ConfigSnapshot): ConfigSnapshot {
  const config = snapshot.config ?? ({} as Partial<WorkhubConfig>)
  const profiles = Array.isArray(config.profiles) ? config.profiles.map(remoteProfile) : []
  const projected: WorkhubConfig = {
    version: config.version as WorkhubConfig['version'],
    connections: [],
    agents: [],
    accounts: [],
    profiles,
    ...(typeof config.activeProfileId === 'string' ? { activeProfileId: config.activeProfileId } : {})
  }
  return {
    config: projected,
    issues: [],
    agents: [],
    providers: [],
    connectionsWithSecret: [],
    dataDir: '',
    ...(snapshot.loadError ? { loadError: 'the desktop could not load its config' } : {})
  }
}

function remoteProfile(p: Profile): Profile {
  const criticalities = p.planner?.inbox?.criticalities
  return {
    id: p.id,
    name: p.name,
    connections: {},
    accountIds: [],
    modules: p.modules,
    ...(p.color ? { color: p.color } : {}),
    ...(p.symbol ? { symbol: p.symbol } : {}),
    // The Plan screens group the inbox by these; the rest of the planner settings stay on the desktop.
    ...(criticalities ? { planner: { inbox: { criticalities } } as unknown as Profile['planner'] } : {})
  }
}

/** An agent the device can pick: names and kind, never its command, args, env or config folder. */
function remoteEffectiveAgent(a: EffectiveAgent): EffectiveAgent {
  const agent = a.agent
  return {
    key: a.key,
    label: a.label,
    agent: { id: agent.id, name: agent.name, adapter: agent.adapter, command: '', args: [], capabilities: agent.capabilities, modeSemantics: agent.modeSemantics, ...(agent.builtIn !== undefined ? { builtIn: agent.builtIn } : {}) },
    account: a.account ? { id: a.account.id, agentId: a.account.agentId, name: a.account.name } : null
  }
}
