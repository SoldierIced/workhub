import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import type { IpcRegistrar } from '../ipc-guard'

export type InvokeHandler = (event: IpcMainInvokeEvent, ...args: any[]) => unknown
export type MessageHandler = (event: IpcMainEvent, ...args: any[]) => void

/** The handlers the app registered, by channel, as it registered them (before the sender guard). */
export interface HandlerTable {
  invoke(channel: string): InvokeHandler | undefined
  message(channel: string): MessageHandler | undefined
}

/**
 * Wraps the registrar the app registers its handlers with, so the same handlers can be reached by
 * another transport (a paired phone) without going through Electron IPC. The recorded listener is
 * the app's own, not the guarded one: the remote dispatcher does its own checks (ipc-guard.ts
 * only knows how to trust a window) and never reaches a handler outside its allowlist.
 */
export function recordIpc(ipc: IpcRegistrar): { ipc: IpcRegistrar; handlers: HandlerTable } {
  const invokes = new Map<string, InvokeHandler>()
  const messages = new Map<string, MessageHandler>()
  return {
    ipc: {
      handle(channel, listener) {
        invokes.set(channel, listener)
        ipc.handle(channel, listener)
      },
      on(channel, listener) {
        messages.set(channel, listener)
        return ipc.on(channel, listener)
      }
    },
    handlers: {
      invoke: (channel) => invokes.get(channel),
      message: (channel) => messages.get(channel)
    }
  }
}
