import { randomUUID } from 'node:crypto'
import type { BrowserWindow, WebContents } from 'electron'
import type { SessionSnapshot } from '../shared/windows-api'

export interface SessionWindowSize {
  width: number
  height: number
  minWidth: number
  minHeight: number
}

export const SESSION_WINDOW_SIZE: SessionWindowSize = { width: 980, height: 760, minWidth: 560, minHeight: 420 }
export const SUBAGENT_WINDOW_SIZE: SessionWindowSize = { width: 900, height: 760, minWidth: 520, minHeight: 400 }

/** The hash a session window loads (see the renderer's main.tsx). */
export function sessionWindowHash(sessionId: string): string {
  return `#session?id=${encodeURIComponent(sessionId)}`
}

export function subagentWindowHash(sessionId: string, subagentId: string): string {
  return `#subagent?session=${encodeURIComponent(sessionId)}&id=${encodeURIComponent(subagentId)}`
}

/** A window's place on screen, in screen coordinates. */
export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

/** What is remembered across launches: the sessions that had a window of their own, by session identity. */
export interface SavedSessionWindows {
  sessions: { key: string; bounds?: WindowBounds }[]
}

/** Where the remembered windows are kept (a `StateFile` in the data folder). */
export interface SessionWindowsStore {
  load(fallback: SavedSessionWindows): SavedSessionWindows
  save(value: SavedSessionWindows): void
  flush(): void
}

export interface SessionWindowsDeps {
  /** `bounds`: where the window was last time (already checked to be on a screen), else the default place. */
  create: (hash: string, size: SessionWindowSize, bounds?: WindowBounds) => BrowserWindow
  mainWindow: () => BrowserWindow | null
  showMain: () => void
  /** Whether the session is still open (a window for a closed session is not opened). */
  exists: (sessionId: string) => boolean
  /** Longest wait for the main window's snapshot of a session. */
  snapshotWaitMs?: number
  /** The session's stable identity (`sessionIdentity`), which survives a relaunch; undefined when it is not open. */
  identityOf?: (sessionId: string) => string | undefined
  /** Remembers the detached sessions and their window bounds across launches. */
  store?: SessionWindowsStore
  /** Runs `fn` once the current event has been handled (tests run it at once). */
  defer?: (fn: () => void) => void
}

const isBounds = (b: unknown): b is WindowBounds =>
  Boolean(b && typeof b === 'object' && ['x', 'y', 'width', 'height'].every((k) => Number.isFinite((b as Record<string, unknown>)[k])))

/** Parses the stored file; anything malformed is left out. */
export function readSavedWindows(raw: unknown): Map<string, WindowBounds | undefined> {
  const out = new Map<string, WindowBounds | undefined>()
  const list = raw && typeof raw === 'object' ? (raw as { sessions?: unknown }).sessions : undefined
  if (!Array.isArray(list)) return out
  for (const entry of list) {
    const key = entry && typeof entry === 'object' ? (entry as { key?: unknown }).key : undefined
    if (typeof key !== 'string' || !key) continue
    const bounds = (entry as { bounds?: unknown }).bounds
    out.set(key, isBounds(bounds) ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } : undefined)
  }
  return out
}

/**
 * Remembered bounds when they still fit a screen (one may have been unplugged since): at least
 * `min` pixels of the window must lie on one of the `screens` work areas, and the size stays
 * within the window's minimum. Undefined: open at the default place.
 */
export function boundsOnScreen(bounds: WindowBounds | undefined, screens: WindowBounds[], size: Pick<SessionWindowSize, 'minWidth' | 'minHeight'>, min = 80): WindowBounds | undefined {
  if (!bounds) return undefined
  const width = Math.max(Math.round(bounds.width), size.minWidth)
  const height = Math.max(Math.round(bounds.height), size.minHeight)
  const x = Math.round(bounds.x)
  const y = Math.round(bounds.y)
  const visible = screens.some((a) => {
    const w = Math.min(x + width, a.x + a.width) - Math.max(x, a.x)
    const h = Math.min(y + height, a.y + a.height) - Math.max(y, a.y)
    // The title bar must be reachable: the window's top edge lies inside the work area.
    return w >= min && h >= Math.min(min, height) && y >= a.y && y < a.y + a.height
  })
  return visible ? { x, y, width, height } : undefined
}

const alive = (w: BrowserWindow | null | undefined): w is BrowserWindow => Boolean(w && !w.isDestroyed())

/**
 * Sessions shown in windows of their own (Workhub 1's "Open in New Window"). The session keeps its
 * one live runtime in main; every window follows its events. While a session has its own window the
 * main window shows a placeholder for it, and closing the window puts it back there.
 */
export class SessionWindows {
  private readonly windows = new Map<string, BrowserWindow>()
  private readonly subagents = new Map<string, BrowserWindow>()
  private readonly waiting = new Map<string, (snapshot: SessionSnapshot | null) => void>()
  private focused: string | null = null
  /** Messages held for a window while it waits for its snapshot, so none is both in it and applied again. */
  private readonly held = new Map<WebContents, [string, unknown[]][]>()
  /** Detached sessions by identity, with their window bounds: what the next launch reopens. */
  private readonly saved: Map<string, WindowBounds | undefined>
  /** The identity each session window was remembered under. */
  private readonly keys = new Map<string, string>()
  /** Sessions whose window is about to be reopened (a change can arrive many times before it opens). */
  private readonly restoring = new Set<string>()
  /** Set while the app quits: windows closing then stay remembered. */
  private suspended = false

  constructor(private readonly deps: SessionWindowsDeps) {
    this.saved = readSavedWindows(deps.store?.load({ sessions: [] }))
  }

  /** Ids of the sessions in windows of their own. */
  detached(): string[] {
    return [...this.windows.keys()]
  }

  /** Every open session and sub-agent window, for broadcasting session events. */
  all(): BrowserWindow[] {
    return [...this.windows.values(), ...this.subagents.values()].filter(alive)
  }

  /** The session of a session window, or undefined for any other window. */
  sessionOf(window: BrowserWindow | null): string | undefined {
    if (!window) return undefined
    for (const [id, w] of this.windows) if (w === window) return id
    return undefined
  }

  open(sessionId: string): void {
    if (typeof sessionId !== 'string' || !this.deps.exists(sessionId)) return
    const open = this.windows.get(sessionId)
    if (alive(open)) return focus(open)
    const key = this.deps.identityOf?.(sessionId)
    const w = this.deps.create(sessionWindowHash(sessionId), SESSION_WINDOW_SIZE, key ? this.saved.get(key) : undefined)
    this.windows.set(sessionId, w)
    if (key) {
      this.keys.set(sessionId, key)
      this.remember(sessionId, w)
    }
    const track = () => this.remember(sessionId, w)
    w.on('move', track)
    w.on('resize', track)
    w.on('focus', () => this.setFocused(sessionId))
    w.on('blur', () => this.focused === sessionId && this.setFocused(null))
    w.on('closed', () => {
      if (this.windows.get(sessionId) === w) {
        this.windows.delete(sessionId)
        // Closed by the user (or its session closed): the next launch does not bring it back.
        this.forget(sessionId)
      }
      if (this.focused === sessionId) this.setFocused(null)
      this.broadcast()
    })
    this.broadcast()
  }

  /**
   * A session changed (or was just opened): a session that had its own window when the app last
   * quit gets it back, at its old place, once the session is open again.
   */
  sessionChanged(sessionId: string): void {
    const key = this.deps.identityOf?.(sessionId)
    if (!key) return
    const known = this.keys.get(sessionId)
    if (this.windows.has(sessionId)) {
      // The identity can arrive after the window opened (an agent reports its session id later).
      if (known !== undefined && known !== key) {
        const bounds = this.saved.get(known)
        this.saved.delete(known)
        this.saved.set(key, bounds)
        this.keys.set(sessionId, key)
        this.persist()
      }
      return
    }
    if (this.suspended || !this.saved.has(key) || this.restoring.has(sessionId)) return
    this.restoring.add(sessionId)
    const run = () => {
      this.restoring.delete(sessionId)
      if (!this.suspended && !this.windows.has(sessionId) && this.saved.has(key) && this.deps.identityOf?.(sessionId) === key) this.open(sessionId)
    }
    if (this.deps.defer) this.deps.defer(run)
    else setTimeout(run, 0)
  }

  /** The app is quitting: windows closing from now on stay remembered for the next launch. */
  suspend(): void {
    if (this.suspended) return
    this.suspended = true
    for (const [id, w] of this.windows) if (alive(w)) this.remember(id, w)
    this.deps.store?.flush()
  }

  /** Identities of the sessions the next launch reopens in windows (for tests and diagnostics). */
  remembered(): string[] {
    return [...this.saved.keys()]
  }

  private remember(sessionId: string, w: BrowserWindow): void {
    const key = this.keys.get(sessionId)
    if (!key || w.isDestroyed()) return
    const b = w.getBounds()
    this.saved.set(key, isBounds(b) ? { x: b.x, y: b.y, width: b.width, height: b.height } : undefined)
    this.persist()
  }

  private forget(sessionId: string): void {
    const key = this.keys.get(sessionId)
    this.keys.delete(sessionId)
    if (this.suspended || !key || !this.saved.delete(key)) return
    this.persist()
  }

  private persist(): void {
    this.deps.store?.save({ sessions: [...this.saved].map(([key, bounds]) => (bounds ? { key, bounds } : { key })) })
  }

  openSubagent(sessionId: string, subagentId: string): void {
    if (typeof sessionId !== 'string' || typeof subagentId !== 'string') return
    const key = `${sessionId}\u0000${subagentId}`
    const open = this.subagents.get(key)
    if (alive(open)) return focus(open)
    const w = this.deps.create(subagentWindowHash(sessionId, subagentId), SUBAGENT_WINDOW_SIZE)
    this.subagents.set(key, w)
    w.on('closed', () => this.subagents.get(key) === w && this.subagents.delete(key))
  }

  /** "Move to Main Window": the window closes and the main window comes up on the session. */
  dock(sessionId: string): void {
    const w = this.windows.get(sessionId)
    this.windows.delete(sessionId)
    this.forget(sessionId)
    if (alive(w)) w.close()
    this.broadcast()
    this.deps.showMain()
    this.deps.mainWindow()?.webContents.send('windows:showSession', sessionId)
  }

  /** A session left the list: its windows have nothing to show. */
  closeSession(sessionId: string): void {
    const w = this.windows.get(sessionId)
    if (alive(w)) w.close()
    for (const [key, sub] of this.subagents) if (key.startsWith(`${sessionId}\u0000`) && alive(sub)) sub.close()
  }

  /** Sends a session message to every session and sub-agent window (held for one waiting for its snapshot). */
  broadcastShared(channel: string, args: unknown[]): void {
    for (const w of this.all()) {
      const queue = this.held.get(w.webContents)
      if (queue) queue.push([channel, args])
      else w.webContents.send(channel, ...args)
    }
  }

  /**
   * A session window's starting point: the chat the main window holds for the session. What the
   * main window gets after the request is held for the asking window and sent after the answer,
   * so the window replaces its chat with the snapshot and then applies only newer messages.
   */
  snapshot(sessionId: string, requester: WebContents): Promise<SessionSnapshot | null> {
    const main = this.deps.mainWindow()
    if (!alive(main)) return Promise.resolve(null)
    const requestId = randomUUID()
    if (!this.held.has(requester)) this.held.set(requester, [])
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish(null), this.deps.snapshotWaitMs ?? 3000)
      const finish = (s: SessionSnapshot | null) => {
        clearTimeout(timer)
        this.waiting.delete(requestId)
        resolve(s)
        // After the answer has gone out (it is sent once this promise settles).
        setTimeout(() => this.release(requester), 0)
      }
      this.waiting.set(requestId, finish)
      main.webContents.send('windows:snapshotRequest', requestId, sessionId)
    })
  }

  reply(requestId: string, snapshot: SessionSnapshot | null): void {
    this.waiting.get(requestId)?.(validSnapshot(snapshot) ? snapshot : null)
  }

  private release(contents: WebContents): void {
    const queue = this.held.get(contents)
    this.held.delete(contents)
    if (!queue || contents.isDestroyed()) return
    for (const [channel, args] of queue) contents.send(channel, ...args)
  }

  private setFocused(id: string | null): void {
    this.focused = id
    this.deps.mainWindow()?.webContents.send('windows:focusedSession', id)
  }

  private broadcast(): void {
    const ids = this.detached()
    const main = this.deps.mainWindow()
    for (const w of [...(alive(main) ? [main] : []), ...this.all()]) w.webContents.send('windows:detached', ids)
  }
}

function focus(w: BrowserWindow): void {
  if (w.isMinimized()) w.restore()
  w.show()
  w.focus()
}

function validSnapshot(s: SessionSnapshot | null): s is SessionSnapshot {
  return Boolean(s && Array.isArray(s.items) && s.monitor && typeof s.monitor === 'object')
}
