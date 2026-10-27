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

export interface SessionWindowsDeps {
  create: (hash: string, size: SessionWindowSize) => BrowserWindow
  mainWindow: () => BrowserWindow | null
  showMain: () => void
  /** Whether the session is still open (a window for a closed session is not opened). */
  exists: (sessionId: string) => boolean
  /** Longest wait for the main window's snapshot of a session. */
  snapshotWaitMs?: number
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

  constructor(private readonly deps: SessionWindowsDeps) {}

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
    const w = this.deps.create(sessionWindowHash(sessionId), SESSION_WINDOW_SIZE)
    this.windows.set(sessionId, w)
    w.on('focus', () => this.setFocused(sessionId))
    w.on('blur', () => this.focused === sessionId && this.setFocused(null))
    w.on('closed', () => {
      if (this.windows.get(sessionId) === w) this.windows.delete(sessionId)
      if (this.focused === sessionId) this.setFocused(null)
      this.broadcast()
    })
    this.broadcast()
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
