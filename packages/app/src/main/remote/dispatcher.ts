import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import type { RemoteCapability } from '../../shared/remote-api'
import type { ConfigSnapshot, StartSessionInput } from '../../shared/api'
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
    const checked = await this.validate(channel, args)
    const result = await handler(this.event(entry) as IpcMainInvokeEvent, ...checked)
    return redactResult(channel, result)
  }

  /** A one-way message (`ipcRenderer.send`) from a device. */
  message(deviceId: string, channel: string, args: unknown[]): void {
    const entry = this.devices.get(deviceId)
    if (!entry) throw new RemoteRefused('the device is not connected')
    if (!remoteAllows(REMOTE_MESSAGES, channel, entry.device.capabilities)) throw this.refuse(deviceId, channel)
    const handler = this.deps.handlers.message(channel)
    if (!handler) throw this.refuse(deviceId, channel)
    handler(this.event(entry) as IpcMainEvent, ...args)
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
    if (channel === 'sessions:start') return [await this.checkedStart(args[0])]
    if (channel === 'sessions:reopen') return [args[0], await this.checkedStart(args[1])]
    return args
  }

  /** A session may only start in a folder the profile lists; never a path the device typed. */
  private async checkedStart(input: unknown): Promise<StartSessionInput> {
    if (!input || typeof input !== 'object') throw new RemoteRefused('a session input is required')
    const start = input as StartSessionInput
    if (typeof start.cwd !== 'string' || !start.cwd) throw new RemoteRefused('a folder is required')
    const profileId = typeof start.profileId === 'string' ? start.profileId : null
    const allowed = await this.deps.profileFolders(profileId)
    if (!allowed.includes(start.cwd)) throw new RemoteRefused('the folder is not one of the profile folders')
    return start
  }
}

/** Results that carry what a device has no use for, trimmed. */
function redactResult(channel: string, result: unknown): unknown {
  if (channel === 'config:get' && result && typeof result === 'object') {
    const snapshot = result as ConfigSnapshot
    return { ...snapshot, dataDir: '' }
  }
  return result
}
