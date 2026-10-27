import { describe, expect, it } from 'vitest'
import { guardIpc, isTrustedRendererUrl, type IpcRegistrar } from '../src/main/ipc-guard'

const packaged = { fileUrl: 'file:///Applications/Workhub%202.app/Contents/Resources/app.asar/out/renderer/index.html' }
const dev = { fileUrl: 'file:///repo/packages/app/out/renderer/index.html', devServerUrl: 'http://localhost:5173' }

describe('isTrustedRendererUrl', () => {
  it('accepts the built index.html with any hash or query', () => {
    expect(isTrustedRendererUrl(packaged.fileUrl, packaged)).toBe(true)
    expect(isTrustedRendererUrl(`${packaged.fileUrl}#pr?profile=work&url=https%3A%2F%2Fgithub.com%2Fa%2Fb%2Fpull%2F1`, packaged)).toBe(true)
    expect(isTrustedRendererUrl(`${packaged.fileUrl}?x=1#/ticket`, packaged)).toBe(true)
  })

  it('refuses other local files, remote pages and odd schemes', () => {
    expect(isTrustedRendererUrl('file:///Applications/Workhub%202.app/Contents/Resources/app.asar/out/renderer/other.html', packaged)).toBe(false)
    expect(isTrustedRendererUrl('file:///tmp/evil/index.html', packaged)).toBe(false)
    expect(isTrustedRendererUrl('https://evil.example.com/index.html', packaged)).toBe(false)
    expect(isTrustedRendererUrl('about:blank', packaged)).toBe(false)
    expect(isTrustedRendererUrl('data:text/html,<script>1</script>', packaged)).toBe(false)
    expect(isTrustedRendererUrl('', packaged)).toBe(false)
    expect(isTrustedRendererUrl(null, packaged)).toBe(false)
    expect(isTrustedRendererUrl('not a url', packaged)).toBe(false)
  })

  it('accepts the dev server origin only in a dev run', () => {
    expect(isTrustedRendererUrl('http://localhost:5173/#pr?x', dev)).toBe(true)
    expect(isTrustedRendererUrl('http://localhost:5173/', packaged)).toBe(false)
    expect(isTrustedRendererUrl('http://localhost:5174/', dev)).toBe(false)
    expect(isTrustedRendererUrl('http://localhost.evil.com:5173/', dev)).toBe(false)
    expect(isTrustedRendererUrl('https://localhost:5173/', dev)).toBe(false)
  })
})

describe('guardIpc', () => {
  type Listener = (event: unknown, ...args: unknown[]) => unknown
  function fakeIpc() {
    const handlers = new Map<string, Listener>()
    const listeners = new Map<string, Listener>()
    const ipc: IpcRegistrar = {
      handle: (channel, listener) => void handlers.set(channel, listener as Listener),
      on: (channel, listener) => void listeners.set(channel, listener as Listener)
    }
    return { ipc, handlers, listeners }
  }
  const from = (url: string | null) => ({ senderFrame: url === null ? null : { url } })
  const trusted = (url: string | null) => url === 'file:///app/index.html'

  it('runs a handler for the app and rejects it for any other sender', async () => {
    const { ipc, handlers } = fakeIpc()
    guardIpc(ipc, trusted).handle('sessions:start', (_e, input) => `started ${String(input)}`)
    const handler = handlers.get('sessions:start')!
    expect(await handler(from('file:///app/index.html'), 'shell')).toBe('started shell')
    expect(() => handler(from('https://evil.example.com/'), 'shell')).toThrow(/not the Workhub window/)
    expect(() => handler(from(null), 'shell')).toThrow(/not the Workhub window/)
  })

  it('drops a one-way message from any other sender', () => {
    const { ipc, listeners } = fakeIpc()
    const received: unknown[] = []
    guardIpc(ipc, trusted).on('sessions:write', (_e, id, data) => void received.push([id, data]))
    const listener = listeners.get('sessions:write')!
    listener(from('https://evil.example.com/'), 's1', 'rm -rf ~\r')
    listener({ get senderFrame() { throw new Error('frame destroyed') } }, 's1', 'x')
    listener(from('file:///app/index.html'), 's1', 'ls\r')
    expect(received).toEqual([['s1', 'ls\r']])
  })
})
