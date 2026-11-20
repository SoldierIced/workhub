import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import type { RemoteCapability, RemotePullRequestList, RemotePullRequestsPage } from '../../shared/remote-api'
import { isUnattendedMode, type AgentEvent, type ConversationEntry, type EffectiveAgent, type Profile, type PullRequestItem, type SubagentConversation, type ToolResultView, type ToolView, type WorkhubConfig } from '@workhub/core'
import type { ConfigSnapshot, HistorySearchResult, SessionView, StartSessionInput } from '../../shared/api'
import type { CodeHostLists } from '../../shared/codehost-api'
import { pageOf, PAGE_BYTES, PageRequestError, readPageRequest, type PageRequest } from './paging'
import { remoteBackgroundTask, remoteSubagentSummary } from './activity'
import type { HandlerTable } from './ipc-recorder'
import { REMOTE_EVENTS, REMOTE_INVOKES, REMOTE_MESSAGES, remoteAllows } from './allowlist'
import { remoteHistorySearch } from './history'
import { readAutomationId, remoteAutomations } from './automations'
import type { AutomationsSnapshot } from '../../shared/chat-api'
import { historySearchOptions } from '../history'

/** See `RemoteHubDeps.startMode`. `permissionModes`: the modes are permission presets, not personas. */
export interface RemoteStartMode {
  configured: string | undefined
  modes(): Promise<{ modes: readonly { id: string }[]; permissionModes: boolean }>
}

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
  /**
   * What a start without a mode would really run in: the account's or the agent's configured
   * default (undefined when none), and, read only when that default is refused, the modes the
   * agent offers. Null when the agent is unknown (the start then fails on its own).
   */
  startMode(input: StartSessionInput): Promise<RemoteStartMode | null>
  /** What the user first asked in a session, already shortened, so a device titles a row the desktop's way without loading its chat. */
  firstPrompt?(sessionId: string): string | undefined
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

/**
 * Lists a device reads a page at a time (`{ limit, cursor }` → `{ items, nextCursor, total }`), by
 * the handler whose answer they page. The handler's answer goes through the same redaction as when
 * the device calls it directly; only then is it cut into pages.
 */
export const PAGED_SOURCES: Readonly<Record<string, string>> = {
  'remote:sessions': 'sessions:list',
  'remote:pullRequests': 'codeHost:lists',
  'remote:automations': 'automations:get'
}

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

/** Permission modes that ask before acting, safest-for-work first: the one a phone start falls back to. */
const ATTENDED_MODES = ['default', 'ask', 'plan', 'read-only', 'readonly', 'read_only']

/**
 * The mode a device's start falls back to when the one it would run in is unattended: the agent's
 * safest attended permission mode, or undefined when it has none (persona agents have no
 * permission modes, so nothing stands in for an unattended persona).
 */
export function attendedFallbackMode(offered: { modes: readonly { id: string }[]; permissionModes: boolean }): string | undefined {
  if (!offered.permissionModes) return undefined
  for (const id of ATTENDED_MODES) {
    const found = offered.modes.find((m) => m.id.toLowerCase() === id)
    if (found && !isRemoteForbiddenMode(found.id)) return found.id
  }
  return undefined
}

/**
 * A start with no mode as it may run when nobody watches it start (a phone, an agent's proposal):
 * unchanged when its configured default asks for permissions, else in the agent's safest attended
 * mode; null when the agent has none, so the start must be refused.
 */
export async function attendedStart(start: StartSessionInput, startMode: (input: StartSessionInput) => Promise<RemoteStartMode | null>): Promise<StartSessionInput | null> {
  const resolved = await startMode(start)
  if (!resolved?.configured || !isRemoteForbiddenMode(resolved.configured)) return start
  const modeId = attendedFallbackMode(await resolved.modes())
  return modeId ? { ...start, modeId } : null
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

/** True for the sender id a handler sees when a paired device, not a window, made the call. */
export function isRemoteSender(senderId: number): boolean {
  return senderId >= FIRST_REMOTE_SENDER_ID
}

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
    const source = PAGED_SOURCES[channel]
    const handler = this.deps.handlers.invoke(source ?? channel)
    if (!handler) throw this.refuse(deviceId, channel)
    const limits = this.limitsOf(deviceId)
    this.spend(deviceId, channel, limits)
    limits.inFlight++
    try {
      const paged = source ? pagedCall(channel, args) : null
      const checked = paged ? paged.sourceArgs : await this.validate(channel, args, entry)
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
      if (!paged || !source) return redactResult(channel, result, (id) => this.deps.firstPrompt?.(id))
      return paged.page(redactResult(source, result, (id) => this.deps.firstPrompt?.(id)))
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

  /**
   * An answer given on a notification (service.ts checked its ticket, signature and that the
   * request still waits). The device may not be connected, so it is named with what it was
   * granted; the answer goes through the same allowlisted message, checks and budget as the
   * chat's buttons.
   */
  answerPermission(device: { id: string; capabilities: ReadonlySet<RemoteCapability> }, sessionId: string, requestId: string, optionId: string): void {
    const channel = 'sessions:permission'
    if (!remoteAllows(REMOTE_MESSAGES, channel, device.capabilities)) throw this.refuse(device.id, channel)
    const handler = this.deps.handlers.message(channel)
    if (!handler) throw this.refuse(device.id, channel)
    this.spend(device.id, channel, this.limitsOf(device.id), false)
    this.validateMessage(channel, [sessionId, requestId])
    handler({ sender: null, senderFrame: null } as unknown as IpcMainEvent, sessionId, requestId, optionId)
  }

  /** One-way messages carry plain tokens. */
  private validateMessage(channel: string, args: unknown[]): void {
    if (channel === 'sessions:permission') {
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
        device.emit(channel, redactEvent(channel, args, (id) => this.deps.firstPrompt?.(id)))
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

  private async validate(channel: string, args: unknown[], entry: { device: RemoteDevice; senderId: number }): Promise<unknown[]> {
    switch (channel) {
      case 'sessions:start':
        return [await this.checkedStart(args[0]), ...args.slice(1)]
      case 'sessions:reopen':
        checkToken(args[0], 'the session identity')
        return [args[0], await this.checkedStart(args[1]), ...args.slice(2)]
      case 'history:search':
        return this.checkedHistorySearch(args[0], args[1])
      case 'automations:runNow':
        return [await this.checkedRunnable(args[0], entry)]
      case 'automations:stop':
        return [checkedAutomationId(args[0])]
      case 'automations:setEnabled':
        // Only off: an agent may have added or edited the automation, and only the desktop turns it on.
        if (args[1] !== false) throw new RemoteRefused('an automation is turned on at the desktop')
        return [checkedAutomationId(args[0]), false]
      default:
        return args
    }
  }

  /**
   * "Run now" starts an agent, and ignores the window and limits: only for an automation that is on.
   * One that is off may be an agent's unreviewed edit, and the person turns those on at the desktop.
   */
  private async checkedRunnable(value: unknown, entry: { device: RemoteDevice; senderId: number }): Promise<string> {
    const id = checkedAutomationId(value)
    const read = this.deps.handlers.invoke('automations:get')
    let snapshot: AutomationsSnapshot | undefined
    try {
      snapshot = read ? ((await read(this.event(entry) as IpcMainInvokeEvent)) as AutomationsSnapshot | undefined) : undefined
    } catch (err) {
      this.deps.log?.warn(`remote: automations:get failed: ${err instanceof Error ? err.message : String(err)}`)
      throw new RemoteRefused(REMOTE_GENERIC_ERROR)
    }
    if (!snapshot?.automations?.some((s) => s.definition.id === id && s.definition.enabled === true)) throw new RemoteRefused('only an automation that is on can run from here')
    return id
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
    return !start.modeId && !start.readOnly ? this.withAttendedMode(start) : start
  }

  /**
   * A start with no mode runs in the account's or the agent's default, which may be one that skips
   * permissions. A device gets that default only when it asks for permission prompts; otherwise
   * the agent's safest attended mode, or no session at all when it has none.
   */
  private async withAttendedMode(start: StartSessionInput): Promise<StartSessionInput> {
    const attended = await attendedStart(start, this.deps.startMode)
    if (!attended) throw new RemoteRefused('this agent starts without permission prompts and has no mode that asks; start the session on the desktop')
    return attended
  }

  /**
   * A device searches the History of the folders it may start sessions in (the profile's, as for
   * `sessions:start`) and nothing else: any folder, account or session list it sends is replaced.
   */
  private async checkedHistorySearch(query: unknown, raw: unknown): Promise<unknown[]> {
    if (typeof query !== 'string') throw new RemoteRefused('a search text is required')
    const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
    const profileId = typeof o['profileId'] === 'string' ? o['profileId'] : null
    const { cwdPrefix: _one, cwdPrefixes: _many, keys: _keys, accountIds: _accounts, ...rest } = historySearchOptions(raw)
    return [query.slice(0, 500), { ...rest, cwdPrefixes: await this.deps.profileFolders(profileId) }]
  }
}

/**
 * A paged call's arguments: what its handler takes, and how its (redacted) answer becomes a page.
 * `remote:pullRequests` takes the profile id first; every paged call takes the page request last.
 */
function pagedCall(channel: string, args: unknown[]): { sourceArgs: unknown[]; page: (result: unknown) => unknown } {
  try {
    switch (channel) {
      case 'remote:sessions': {
        const request = readPageRequest(args[0])
        return { sourceArgs: [], page: (r) => pageOf(Array.isArray(r) ? (r as SessionView[]) : [], request, (v) => String(v?.id), { stub: sessionStub }) }
      }
      case 'remote:pullRequests': {
        const profileId = args[0] ?? null
        if (profileId !== null && typeof profileId !== 'string') throw new RemoteRefused('the profile is not valid')
        const request = readPageRequest(args[1])
        const list = (args[1] as { list?: unknown } | undefined)?.list
        if (list !== undefined && list !== 'mine' && list !== 'toReview') throw new RemoteRefused('the list is not valid')
        return { sourceArgs: [profileId], page: (r) => pullRequestsPage(r as CodeHostLists, request, list) }
      }
      case 'remote:automations': {
        const request = readPageRequest(args[0])
        return { sourceArgs: [], page: (r) => pageOf(remoteAutomations(r as AutomationsSnapshot), request, (a) => a.id) }
      }
      default:
        throw new RemoteRefused(`${channel} is not available remotely`)
    }
  } catch (err) {
    if (err instanceof PageRequestError) throw new RemoteRefused(err.message)
    throw err
  }
}

function checkedAutomationId(value: unknown): string {
  const id = readAutomationId(value)
  if (id === null) throw new RemoteRefused('the automation is not valid')
  return id
}

/** A session that does not fit a page on its own: enough for the list to name it. */
function sessionStub(v: SessionView): SessionView {
  return { id: v.id, label: v.label, state: v.state, tooLarge: true } as SessionView
}

/**
 * The lists' state without their rows, how many each holds, and a page of the list asked for, or
 * the first page of each (each in half a page's bytes, so both fit one frame). Rows without a
 * link are left out: the phone could neither open nor tell them apart.
 */
function pullRequestsPage(lists: CodeHostLists, request: PageRequest, only?: RemotePullRequestList): RemotePullRequestsPage {
  const linked = (items: unknown) => (Array.isArray(items) ? (items as PullRequestItem[]).filter((i) => typeof i?.pr?.url === 'string' && i.pr.url !== '') : [])
  const mine = linked(lists?.mine)
  const toReview = linked(lists?.toReview)
  const { mine: _mine, toReview: _toReview, ...rest } = lists ?? ({} as CodeHostLists)
  const out: RemotePullRequestsPage = { lists: rest, counts: { mine: mine.length, toReview: toReview.length } }
  const key = (i: PullRequestItem) => i.pr.url
  if (only) out[only] = pageOf(only === 'mine' ? mine : toReview, request, key)
  else {
    const first = { ...request, cursor: null }
    out.mine = pageOf(mine, first, key, { maxBytes: PAGE_BYTES / 2 })
    out.toReview = pageOf(toReview, first, key, { maxBytes: PAGE_BYTES / 2 })
  }
  return out
}

/** Events that carry what a device has no use for, trimmed like the matching results. */
function redactEvent(channel: string, args: unknown[], firstPrompt?: (sessionId: string) => string | undefined): unknown[] {
  if (channel === 'session:changed' && args[0] && typeof args[0] === 'object') return [remoteSessionView(args[0] as SessionView, firstPrompt), ...args.slice(1)]
  if (channel === 'session:event' && args[0] && typeof args[0] === 'object') return [remoteAgentEvent(args[0] as AgentEvent), ...args.slice(1)]
  // The snapshot holds every prompt and folder and may not fit a frame: the device only learns it changed and reads its page again.
  if (channel === 'automations:changed') return []
  return args
}

/** A monitor update's sub-agents and background tasks as `remote:activity` sends them: no model, tokens or cost, text cut. */
export function remoteAgentEvent(e: AgentEvent): AgentEvent {
  if (e.type !== 'monitor' || !e.snapshot || typeof e.snapshot !== 'object') return e
  const { subagents, backgroundTasks } = e.snapshot
  if (!Array.isArray(subagents) && !Array.isArray(backgroundTasks)) return e
  return {
    ...e,
    snapshot: {
      ...e.snapshot,
      ...(Array.isArray(subagents) ? { subagents: subagents.map(remoteSubagentSummary) } : {}),
      ...(Array.isArray(backgroundTasks) ? { backgroundTasks: backgroundTasks.map(remoteBackgroundTask) } : {})
    }
  }
}

/** How much of a slash command's description a device gets: enough for the menu line. */
const COMMAND_DESCRIPTION_MAX = 120
/** How much of a waiting permission request's title and detail a device gets. */
const PERMISSION_TEXT_MAX = 600
/** Slash commands a device gets per session; an agent with hundreds of skills would otherwise fill the frame. */
const COMMANDS_MAX = 300

/**
 * A session as a device sees it. Every session carries its agent's slash commands and models with
 * their descriptions: a few dozen kilobytes each with many skills installed, which across a dozen
 * sessions no longer fit one relay frame. The device gets the names and a short description.
 */
export function remoteSessionView(view: SessionView, firstPrompt?: (sessionId: string) => string | undefined): SessionView {
  if (!view || typeof view !== 'object') return view
  const out: SessionView = { ...view }
  // What the sidebar names a session by when nothing else does; the device has not loaded its chat, so it cannot work it out. Already cut to a row's length.
  const asked = typeof view.id === 'string' ? firstPrompt?.(view.id) : undefined
  if (asked) out.firstPrompt = asked
  if (Array.isArray(view.commands)) {
    out.commands = view.commands.slice(0, COMMANDS_MAX).map((c) => ({
      name: c.name,
      group: c.group,
      ...(c.argumentHint ? { argumentHint: c.argumentHint.slice(0, 60) } : {}),
      ...(c.description ? { description: c.description.length > COMMAND_DESCRIPTION_MAX ? `${c.description.slice(0, COMMAND_DESCRIPTION_MAX - 1)}…` : c.description } : {})
    }))
  }
  if (Array.isArray(view.models)) out.models = view.models.map((m) => ({ id: m.id, name: m.name }))
  // A waiting request's text is cut as a sub-agent's step is: one long prompt must not make the session unsendable.
  if (Array.isArray(view.pendingPermissions))
    out.pendingPermissions = view.pendingPermissions.map((p) => ({ ...p, title: cutText(String(p.title ?? ''), PERMISSION_TEXT_MAX), ...(typeof p.detail === 'string' ? { detail: cutText(p.detail, PERMISSION_TEXT_MAX) } : {}) }))
  return out
}

/** A sub-agent's conversation stays well under the relay's frame once sealed. */
export const SUBAGENT_MAX_BYTES = 256 * 1024
/** Text of one step a device gets; the full text stays on the desktop. */
const SUBAGENT_TEXT_MAX = 6_000

const bytesOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? '')
const cutText = (text: string, max = SUBAGENT_TEXT_MAX): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/** One step as the phone shows it: no tool output or diffs, long text cut. */
function slimEntry(e: ConversationEntry): ConversationEntry {
  if (e.kind !== 'tool') return { ...e, text: cutText(e.text) }
  const { result, view, ...rest } = e
  // A Task call keeps the id of the sub-agent it started, so the phone can open it.
  const agentId = result?.agentId
  // Only what the phone draws: the kind, and the path of a file it can open. Not the edits or content.
  const keep = (view.kind === 'read' || view.kind === 'write' || view.kind === 'edit' ? { kind: view.kind, path: view.path } : { kind: view.kind }) as ToolView
  return {
    ...rest,
    ...(rest.detail ? { detail: cutText(rest.detail, 600) } : {}),
    view: keep,
    ...(agentId ? { result: { agentId } as ToolResultView } : {})
  }
}

/**
 * A sub-agent's conversation as a device sees it: the steps without their output, long text cut,
 * and the oldest steps left out (counted in `omitted`) until it fits one relay frame.
 */
export function remoteSubagent(c: SubagentConversation): SubagentConversation {
  if (!c || typeof c !== 'object' || !Array.isArray(c.entries)) return c
  const out: SubagentConversation = {
    ...c,
    ...(c.prompt ? { prompt: cutText(c.prompt, 12_000) } : {}),
    ...(c.result ? { result: cutText(c.result, 24_000) } : {}),
    entries: []
  }
  let budget = SUBAGENT_MAX_BYTES - bytesOf(out)
  let kept = 0
  const entries: ConversationEntry[] = []
  for (let i = c.entries.length - 1; i >= 0; i--) {
    const entry = slimEntry(c.entries[i]!)
    const size = bytesOf(entry)
    if (size > budget) break
    budget -= size
    entries.push(entry)
    kept++
  }
  out.entries = entries.reverse()
  const omitted = (c.omitted ?? 0) + (c.entries.length - kept)
  if (omitted > 0) out.omitted = omitted
  return out
}

/** Results that carry what a device has no use for, trimmed. */
function redactResult(channel: string, result: unknown, firstPrompt?: (sessionId: string) => string | undefined): unknown {
  if (channel === 'config:get' && result && typeof result === 'object') return remoteConfigSnapshot(result as ConfigSnapshot)
  if (channel === 'sessions:list' && Array.isArray(result)) return (result as SessionView[]).map((v) => remoteSessionView(v, firstPrompt))
  if (channel === 'config:effectiveAgents' && Array.isArray(result)) return (result as EffectiveAgent[]).map(remoteEffectiveAgent)
  if (channel === 'sessions:subagent' && result && typeof result === 'object') return remoteSubagent(result as SubagentConversation)
  if (channel === 'history:search' && result && typeof result === 'object') return remoteHistorySearch(result as HistorySearchResult)
  // The answer carries the whole config (connections, agents): the device learns only whether it worked.
  if (channel === 'automations:setEnabled') return { ok: (result as { ok?: unknown } | null)?.ok === true }
  return result
}

/**
 * The config as a device sees it: the profiles' names, colors and Plan criticalities and the active
 * profile, the sidebar's groups and the accounts' names. Never connections, account folders or
 * environment, agent definitions (env, commands), automations, folders or the data folder; the
 * other keys stay, empty, so the snapshot keeps its shape.
 */
export function remoteConfigSnapshot(snapshot: ConfigSnapshot): ConfigSnapshot {
  const config = snapshot.config ?? ({} as Partial<WorkhubConfig>)
  const profiles = Array.isArray(config.profiles) ? config.profiles.map(remoteProfile) : []
  const projected: WorkhubConfig = {
    version: config.version as WorkhubConfig['version'],
    connections: [],
    agents: [],
    // Names only, so a row names and colours its account as the sidebar does; never its folder or environment.
    accounts: Array.isArray(config.accounts) ? config.accounts.map((a) => ({ id: a.id, agentId: a.agentId, name: a.name })) : [],
    profiles,
    ...(typeof config.activeProfileId === 'string' ? { activeProfileId: config.activeProfileId } : {}),
    // The sidebar's groups and order, so the device lists sessions as the desktop does.
    ...(config.sessionGroups ? { sessionGroups: config.sessionGroups } : {})
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
