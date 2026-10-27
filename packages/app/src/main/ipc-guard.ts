import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'

/** The two `ipcMain` methods the app registers handlers with; `ipcMain` itself and the guarded registrar both fit. */
export interface IpcRegistrar {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown): void
  on(channel: string, listener: (event: IpcMainEvent, ...args: any[]) => void): unknown
}

/** Where the app's own renderer is loaded from: the built index.html, or the dev server in a dev run. */
export interface RendererOrigin {
  /** Absolute file:// URL of the built renderer's index.html. */
  fileUrl: string
  /** The electron-vite dev server URL (ELECTRON_RENDERER_URL), only set in a dev run. */
  devServerUrl?: string
}

function parse(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

/**
 * True only for a frame showing the app's own renderer: the exact built index.html (any hash or
 * query, since windows are routed by hash) or a page of the dev server's origin. Anything else
 * (a remote page, another local file, about:blank, data:) is not the app.
 */
export function isTrustedRendererUrl(url: string | undefined | null, origin: RendererOrigin): boolean {
  if (!url) return false
  const target = parse(url)
  if (!target) return false
  if (target.protocol === 'file:') {
    const own = parse(origin.fileUrl)
    return own !== null && own.protocol === 'file:' && target.host === own.host && target.pathname === own.pathname
  }
  if (!origin.devServerUrl) return false
  const dev = parse(origin.devServerUrl)
  return dev !== null && (dev.protocol === 'http:' || dev.protocol === 'https:') && target.origin === dev.origin
}

type SenderEvent = Pick<IpcMainEvent | IpcMainInvokeEvent, 'senderFrame'>

/** The URL of the frame that sent an IPC message; null once that frame is gone. */
export function senderUrl(event: SenderEvent): string | null {
  try {
    return event.senderFrame?.url ?? null
  } catch {
    // Reading a destroyed frame throws.
    return null
  }
}

/**
 * Wraps `ipcMain` so every handler first checks that the message came from the app's own
 * renderer. A page that got into a window some other way (a link that slipped past the navigation
 * guard) keeps the preload's `window.hub`, so the sender is checked here too: an invoke from it
 * rejects, a one-way message from it is dropped.
 */
export function guardIpc(ipc: IpcRegistrar, isTrusted: (url: string | null) => boolean): IpcRegistrar {
  return {
    handle(channel, listener) {
      ipc.handle(channel, (event, ...args) => {
        if (!isTrusted(senderUrl(event))) throw new Error(`Refused ${channel}: the sender is not the Workhub window`)
        return listener(event, ...args)
      })
    },
    on(channel, listener) {
      ipc.on(channel, (event, ...args) => {
        if (!isTrusted(senderUrl(event))) return
        listener(event, ...args)
      })
    }
  }
}
