import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { deleteFlowMap, importFlowMapFiles, saveFlowMap } from '../src/main/flow-maps'
import { flowMapWindowHash, registerFlowMapsIpc, type FlowMapsIpcDeps } from '../src/main/flow-maps-ipc'
import { parseFlowMapHash } from '../src/renderer/screens/flowMaps/FlowMapWindow'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'wh-flow-maps-ipc-'))
  dirs.push(d)
  return d
}
const checkout = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'docs', 'examples', 'flow-maps', 'checkout.json'), 'utf8')) as Record<string, unknown>

describe('flow map files from Settings', () => {
  it('imports the valid files picked and reports the rest with their errors', () => {
    const dir = join(tmp(), 'flow-maps')
    const src = tmp()
    writeFileSync(join(src, 'good.json'), JSON.stringify(checkout))
    writeFileSync(join(src, 'broken.json'), '{ nope')
    writeFileSync(join(src, 'refs.json'), JSON.stringify({ ...checkout, id: 'refs', edges: [{ from: 'bff', to: 'nowhere' }] }))
    const results = importFlowMapFiles(dir, [join(src, 'good.json'), join(src, 'broken.json'), join(src, 'refs.json')])
    expect(results[0]).toEqual({ file: join(src, 'good.json'), ok: true, id: 'checkout' })
    expect(results[1]).toMatchObject({ ok: false, errors: [expect.stringContaining('JSON')] })
    expect(results[2]).toMatchObject({ ok: false, errors: [expect.stringContaining('nowhere')] })
    expect(existsSync(join(dir, 'checkout.json'))).toBe(true)
    expect(existsSync(join(dir, 'refs.json'))).toBe(false)
  })

  it('deletes a map by id and refuses anything that is not an id', () => {
    const dir = join(tmp(), 'flow-maps')
    saveFlowMap(dir, checkout)
    expect(deleteFlowMap(dir, '../checkout')).toBe(false)
    expect(deleteFlowMap(dir, 'checkout/..')).toBe(false)
    expect(deleteFlowMap(dir, 'missing')).toBe(false)
    expect(deleteFlowMap(dir, 'checkout')).toBe(true)
    expect(existsSync(join(dir, 'checkout.json'))).toBe(false)
  })
})

describe('flow map window hash', () => {
  it('round-trips the profile, environment and map, and rejects other hashes', () => {
    const hash = flowMapWindowHash('acme', 'prod', 'checkout')
    expect(parseFlowMapHash(hash)).toEqual({ profileId: 'acme', environmentId: 'prod', mapId: 'checkout' })
    expect(parseFlowMapHash(flowMapWindowHash(null, 'prod', 'a b'))).toEqual({ profileId: null, environmentId: 'prod', mapId: 'a b' })
    expect(parseFlowMapHash('#flow-map?env=prod')).toBeNull()
    expect(parseFlowMapHash('#file?path=x')).toBeNull()
  })
})

describe('flow maps IPC', () => {
  type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
  type Listener = (event: IpcMainEvent, ...args: unknown[]) => void
  const setup = (over: Partial<FlowMapsIpcDeps> = {}) => {
    const handlers = new Map<string, Handler>()
    const listeners = new Map<string, Listener>()
    const win = { isDestroyed: () => false, isMinimized: () => false, restore: vi.fn(), focus: vi.fn(), on: vi.fn(), webContents: { send: vi.fn() } }
    const deps: FlowMapsIpcDeps = {
      dir: join(tmp(), 'flow-maps'),
      pickFiles: async () => [],
      showItemInFolder: vi.fn(),
      createWindow: vi.fn(() => win as never),
      mainWindow: () => win as never,
      writeImage: vi.fn(async () => true),
      ...over
    }
    registerFlowMapsIpc({ handle: (c, h) => handlers.set(c, h as Handler), on: (c, l) => listeners.set(c, l as Listener) }, deps)
    const event = {} as IpcMainInvokeEvent
    return { deps, win, invoke: (c: string, ...a: unknown[]) => handlers.get(c)!(event, ...a), send: (c: string, ...a: unknown[]) => listeners.get(c)!(event as never, ...a) }
  }

  it('creates the folder when asked for it or revealed', async () => {
    const { deps, invoke, send } = setup()
    expect(await invoke('flowMaps:folder')).toBe(deps.dir)
    expect(existsSync(deps.dir)).toBe(true)
    send('flowMaps:reveal')
    expect(deps.showItemInFolder).toHaveBeenCalledWith(deps.dir)
  })

  it('opens one window per map and brings an open one to the front', () => {
    const { deps, win, send } = setup()
    send('flowMaps:openWindow', 'acme', 'prod', 'checkout')
    send('flowMaps:openWindow', 'acme', 'prod', 'checkout')
    expect(deps.createWindow).toHaveBeenCalledTimes(1)
    expect(deps.createWindow).toHaveBeenCalledWith('#flow-map?profile=acme&env=prod&id=checkout', 'Flow map')
    expect(win.focus).toHaveBeenCalledTimes(1)
    send('flowMaps:openWindow', 'acme', 42, 'checkout')
    expect(deps.createWindow).toHaveBeenCalledTimes(1)
  })

  it('copies only a PNG data URL, and forwards "Ask Claude" to the main window with its draft', async () => {
    const { deps, win, invoke, send } = setup()
    expect(await invoke('flowMaps:copyImage', 'data:image/png;base64,AAAA')).toBe(true)
    expect(await invoke('flowMaps:copyImage', 'data:text/html;base64,AAAA')).toBe(false)
    expect(deps.writeImage).toHaveBeenCalledTimes(1)
    send('flowMaps:ask', 'Look at this flow', '/w/acme/shop')
    expect(win.webContents.send).toHaveBeenCalledWith('flowMaps:askInMain', 'Look at this flow', '/w/acme/shop')
    send('flowMaps:ask', '   ')
    expect(win.webContents.send).toHaveBeenCalledTimes(1)
  })
})
