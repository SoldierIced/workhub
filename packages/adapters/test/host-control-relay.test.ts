import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HOST_PROTOCOL_VERSION } from '@workhub/core'
import {
  CONTROL_REQUEST_EVENT,
  CONTROL_RESPOND_METHOD,
  ControlRelay,
  HOST_INFO_METHOD,
  HostChannel,
  HostClient,
  hostInfoSchema,
  hostSocketDir,
  hostSocketPath,
  relayedControlRequestSchema,
  runHost,
  type HostedServices,
  type RelayedControlRequest
} from '../src/host'

const VERSION = '2.0.0-test'
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'wh-relay-'))
  dirs.push(d)
  return d
}

function call(socketPath: string, method: string, path: string, body?: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, method, path, headers }, (res) => {
      let text = ''
      res.on('data', (c) => (text += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

const hosted = (): HostedServices => ({ runtimes: {}, transcripts: [], history: {}, git: vi.fn() })

/** A host over in-memory pipes with a control socket, and a client that answers relayed requests as the app does. */
function connect(socketPath: string, ownedDir: string | null = null) {
  const toHost = new PassThrough()
  const fromHost = new PassThrough()
  const client = new HostClient(new HostChannel(fromHost, toHost), { expected: { protocol: HOST_PROTOCOL_VERSION, hostVersion: VERSION } })
  const host = runHost({ input: toHost, output: fromHost, hostVersion: VERSION, services: hosted(), platform: 'linux', home: '/users/ana', control: { socketPath, ownedDir }, node: '/opt/node/bin/node', bridgeDir: '/opt/wh/bridge' })
  return { host, client }
}

describe.skipIf(process.platform === 'win32')('control relay', () => {
  it('relays a request on the host socket to the app and its answer back', async () => {
    const socket = join(tempDir(), 'host.sock')
    const { host, client } = connect(socket)
    const seen: RelayedControlRequest[] = []
    client.onEvent(CONTROL_REQUEST_EVENT, (p) => {
      const req = relayedControlRequestSchema.parse(p)
      seen.push(req)
      void client.request(CONTROL_RESPOND_METHOD, { rid: req.rid, status: 202, headers: { 'content-type': 'application/json' }, body: '{"ok":true,"pending":true}' })
    })
    const hello = await client.ready
    expect(hello.features).toContain('control')
    const info = hostInfoSchema.parse(await client.request(HOST_INFO_METHOD))
    expect(info).toEqual({ control: { socket }, node: '/opt/node/bin/node', mcpScript: join('/opt/wh/bridge', 'workhub-mcp.mjs') })
    expect(statSync(socket).mode & 0o777).toBe(0o600)

    const r = await call(socket, 'POST', '/v1/notify?x=1', '{"title":"Tests pass"}', { 'x-workhub-token': 'st', 'content-type': 'application/json' })
    expect(r).toEqual({ status: 202, body: '{"ok":true,"pending":true}' })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/v1/notify?x=1', body: '{"title":"Tests pass"}' })
    expect(seen[0]!.headers).toMatchObject({ 'x-workhub-token': 'st', 'content-type': 'application/json' })

    // An answer for a request nobody waits for is not delivered.
    expect(await client.request(CONTROL_RESPOND_METHOD, { rid: 999, status: 200, headers: {}, body: '' })).toEqual({ delivered: false })
    await expect(client.request(CONTROL_RESPOND_METHOD, { rid: 1 })).rejects.toMatchObject({ code: 'bad_params' })

    await host.shutdown()
    expect(existsSync(socket)).toBe(false)
  })

  it('removes the socket and the folder it made when the channel closes', async () => {
    const parent = tempDir()
    const owned = mkdtempSync(join(parent, 'workhub-host-'))
    const socket = hostSocketPath(owned, 4242)
    expect(socket).toBe(join(owned, 'host-4242.sock'))
    const { client } = connect(socket, owned)
    await client.request(HOST_INFO_METHOD)
    expect(existsSync(socket)).toBe(true)
    const exited = new Promise<void>((resolve) => client.onClose(() => resolve()))
    client.close()
    await exited
    await vi.waitFor(() => expect(existsSync(owned)).toBe(false))
  })

  it('answers 504 when the app does not answer in time and 413 over the cap', async () => {
    const socket = join(tempDir(), 'relay.sock')
    const emitted: unknown[] = []
    const relay = new ControlRelay({ emit: (_e, p) => (emitted.push(p), true), timeoutMs: 50, maxBody: 16 })
    await relay.listen(socket)
    const timedOut = await call(socket, 'GET', '/v1/plan/today')
    expect(timedOut.status).toBe(504)
    expect(JSON.parse(timedOut.body)).toMatchObject({ ok: false })
    expect(emitted).toHaveLength(1)

    const big = await call(socket, 'POST', '/v1/inbox', 'x'.repeat(64))
    expect(big.status).toBe(413)
    expect(emitted).toHaveLength(1)

    relay.close()
    expect(existsSync(socket)).toBe(false)
    expect(relay.socketPath).toBeNull()
  })

  it('answers 503 past the waiting limit, to waiting requests on close, and 413 when a request does not fit the channel', async () => {
    const socket = join(tempDir(), 'relay.sock')
    const emitted: unknown[] = []
    let throwNext = true
    const relay = new ControlRelay({
      emit: (_e, p) => {
        if (throwNext) throw new Error('host message too large')
        emitted.push(p)
        return true
      },
      maxPending: 1
    })
    await relay.listen(socket)
    expect((await call(socket, 'POST', '/v1/inbox', '{}')).status).toBe(413)
    throwNext = false
    const waiting = call(socket, 'GET', '/v1/people')
    await vi.waitFor(() => expect(emitted).toHaveLength(1))
    // One request already waits: the next is refused at once.
    expect((await call(socket, 'GET', '/v1/milestones')).status).toBe(503)
    relay.close()
    expect((await waiting).status).toBe(503)
  })

  it('keeps the socket in a private folder: XDG_RUNTIME_DIR when usable, else a new temp folder', () => {
    const runtime = tempDir()
    const fromXdg = hostSocketDir({ XDG_RUNTIME_DIR: runtime }, '/unused')
    expect(fromXdg).toEqual({ dir: join(runtime, 'workhub'), created: null })
    expect(statSync(fromXdg.dir).mode & 0o777).toBe(0o700)
    const tmp = tempDir()
    const fallback = hostSocketDir({}, tmp)
    dirs.push(fallback.dir)
    expect(fallback.created).toBe(fallback.dir)
    // A temp folder too long for a socket path (macOS's /var/folders/…) gives way to /tmp.
    const roomy = Buffer.byteLength(join(tmp, 'workhub-host-XXXXXX', 'host-4294967295.sock')) <= 100
    expect(fallback.dir.startsWith(join(roomy ? tmp : '/tmp', 'workhub-host-'))).toBe(true)
    const long = join(tmp, 'x'.repeat(100))
    const short = hostSocketDir({}, long)
    dirs.push(short.dir)
    expect(short.dir.startsWith(join('/tmp', 'workhub-host-'))).toBe(true)
    expect(statSync(fallback.dir).mode & 0o777).toBe(0o700)
  })
})
