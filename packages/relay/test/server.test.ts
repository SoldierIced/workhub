import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { generateIdentity, makeAuth, type RelayMessage } from '@workhub/protocol'
import { createRelayServer, type RelayServer } from '../src/server'
import { resolveStatic } from '../src/static'
import { FilePushStore } from '../src/push-store'

let server: RelayServer
let base: string
let webDir: string

beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), 'relay-web-'))
  mkdirSync(join(webDir, 'assets'))
  writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>Workhub</title>')
  writeFileSync(join(webDir, 'assets', 'app-abc123.js'), 'console.log(1)')
  server = createRelayServer({ webClientDir: webDir, authTimeoutMs: 300, heartbeatMs: 60_000, version: 'test' })
  await new Promise<void>((done) => server.http.listen(0, '127.0.0.1', () => done()))
  const address = server.http.address() as { port: number }
  base = `127.0.0.1:${address.port}`
})

afterAll(() => server.close())

function connect(): Promise<{ ws: WebSocket; next: () => Promise<RelayMessage>; closed: Promise<[number, string]> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${base}/ws`)
    const queue: RelayMessage[] = []
    const waiters: ((m: RelayMessage) => void)[] = []
    ws.on('message', (data) => {
      const m = JSON.parse(data.toString()) as RelayMessage
      const w = waiters.shift()
      if (w) w(m)
      else queue.push(m)
    })
    const closed = new Promise<[number, string]>((done) => ws.on('close', (code, reason) => done([code, reason.toString()])))
    ws.on('open', () => resolve({ ws, next: () => (queue.length ? Promise.resolve(queue.shift()!) : new Promise((r) => waiters.push(r))), closed }))
    ws.on('error', reject)
  })
}

describe('relay server', () => {
  it('answers health and serves the web client with a SPA fallback', async () => {
    const health = await fetch(`http://${base}/healthz`).then((r) => r.json())
    expect(health).toMatchObject({ ok: true, version: 'test', push: false })
    const index = await fetch(`http://${base}/`)
    expect(index.headers.get('content-type')).toContain('text/html')
    expect(await index.text()).toContain('Workhub')
    const fallback = await fetch(`http://${base}/pair`)
    expect(await fallback.text()).toContain('Workhub')
    const asset = await fetch(`http://${base}/assets/app-abc123.js`)
    expect(asset.headers.get('cache-control')).toContain('immutable')
    expect((await fetch(`http://${base}/missing.png`)).status).toBe(404)
  })

  it('relays between two authenticated sockets', async () => {
    const desktop = generateIdentity()
    const phone = generateIdentity()
    const a = await connect()
    const b = await connect()
    a.ws.send(JSON.stringify(makeAuth(desktop)))
    expect(await a.next()).toMatchObject({ t: 'welcome', id: desktop.id })
    b.ws.send(JSON.stringify(makeAuth(phone)))
    expect(await b.next()).toMatchObject({ t: 'welcome', id: phone.id })
    a.ws.send(JSON.stringify({ t: 'join', room: desktop.id }))
    expect(await a.next()).toMatchObject({ t: 'joined' })
    b.ws.send(JSON.stringify({ t: 'join', room: desktop.id }))
    expect(await b.next()).toMatchObject({ t: 'joined', peers: [desktop.id] })
    expect(await a.next()).toMatchObject({ t: 'peer', id: phone.id, online: true })
    b.ws.send(JSON.stringify({ t: 'to', room: desktop.id, to: desktop.id, body: { k: 'enc', c: 'hello' } }))
    expect(await a.next()).toEqual({ t: 'from', room: desktop.id, from: phone.id, body: { k: 'enc', c: 'hello' } })
    b.ws.close()
    expect(await a.next()).toMatchObject({ t: 'peer', id: phone.id, online: false })
    a.ws.close()
  })

  it('closes a socket that never authenticates', async () => {
    const c = await connect()
    expect(await c.closed).toEqual([1008, 'auth timeout'])
  })
})

describe('resolveStatic', () => {
  it('never leaves the root', () => {
    expect(resolveStatic(webDir, '/../index.html')).toBeNull()
    expect(resolveStatic(webDir, '/%2e%2e/%2e%2e/etc/passwd')).toBeNull()
    expect(resolveStatic(webDir, '/')?.path).toBe(join(webDir, 'index.html'))
    expect(resolveStatic(webDir, '/anything?x=1')?.path).toBe(join(webDir, 'index.html'))
  })
})

describe('FilePushStore', () => {
  it('persists records across instances and writes the file privately', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-push-'))
    const path = join(dir, 'nested', 'push.json')
    const a = new FilePushStore(path)
    a.set('d1', { sub: { endpoint: 'https://push.example.com/x', keys: { p256dh: 'p', auth: 'a' } }, rooms: ['r1'], updatedAt: 1 })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toHaveProperty('d1')
    const b = new FilePushStore(path)
    expect(b.get('d1')?.rooms).toEqual(['r1'])
    expect(b.size()).toBe(1)
    b.delete('d1')
    expect(new FilePushStore(path).size()).toBe(0)
  })
})
