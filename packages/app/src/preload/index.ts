import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { toPlatform } from '../shared/api'
import { buildHub, type HubTransport } from '../shared/hub-client'

// Electron IPC as the hub's transport; the web client gives buildHub a WebSocket one instead.
const transport: HubTransport = {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  send: (channel, ...args) => ipcRenderer.send(channel, ...args),
  subscribe<A extends unknown[]>(channel: string, cb: (...args: A) => void): () => void {
    const listener = (_e: IpcRendererEvent, ...args: unknown[]) => cb(...(args as A))
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }
}

contextBridge.exposeInMainWorld('hub', buildHub(transport, toPlatform(process.platform)))
