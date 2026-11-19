import { X509Certificate } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { classifyNetworkError, createElasticTransport, ElasticError } from '../src/health-elastic'

// A self-signed certificate made only for these tests (CN=localhost, 127.0.0.1).
const fixture = (name: string) => readFileSync(new URL(`./fixtures/tls/${name}`, import.meta.url))
const cert = fixture('cert.pem')
const key = fixture('key.pem')
const certFingerprint = new X509Certificate(cert).fingerprint256

const servers: (NetServer | HttpServer)[] = []
const sockets: Socket[] = []

afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy()
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))))
})

async function listen<T extends NetServer | HttpServer>(server: T): Promise<number> {
  servers.push(server)
  server.on('connection', (s: Socket) => sockets.push(s))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return (server.address() as AddressInfo).port
}

async function failure(run: Promise<unknown>): Promise<unknown> {
  try {
    await run
  } catch (error) {
    return error
  }
  throw new Error('expected the request to fail')
}

describe('createElasticTransport', () => {
  it('reports a connection that never completes as an unreachable cluster, not as a slow query', async () => {
    // Accepts TCP but never answers the TLS handshake, like a host behind a VPN that is down.
    const port = await listen(createNetServer(() => {}))
    const http = createElasticTransport({ mode: 'insecure' })
    const error = await failure(http({ method: 'POST', url: `https://127.0.0.1:${port}/x/_count`, headers: {}, body: '{}', timeoutMs: 200 }))
    const classified = classifyNetworkError(error, 200)
    expect(classified.kind).toBe('unreachable')
    expect(classified.isConnectionLevel).toBe(true)
  })

  it('reports a connected cluster that does not answer in time as a timed-out query', async () => {
    const port = await listen(createHttpServer(() => {}))
    const http = createElasticTransport({ mode: 'system' })
    const error = await failure(http({ method: 'POST', url: `http://127.0.0.1:${port}/x/_count`, headers: {}, body: '{}', timeoutMs: 200 }))
    const classified = classifyNetworkError(error, 200)
    expect(classified.kind).toBe('timedOut')
    expect(classified.isConnectionLevel).toBe(false)
  })

  it('reaches a self-signed cluster whose certificate matches the pin', async () => {
    const port = await listen(createHttpsServer({ cert, key }, (_req, res) => res.end('{"count":3}')))
    const http = createElasticTransport({ mode: 'pinned', fingerprint: certFingerprint })
    const res = await http({ method: 'POST', url: `https://127.0.0.1:${port}/x/_count`, headers: {}, body: '{}', timeoutMs: 2000 })
    expect(res).toEqual({ status: 200, text: '{"count":3}' })
  })

  it('rejects a self-signed cluster whose certificate does not match the pin', async () => {
    const port = await listen(createHttpsServer({ cert, key }, (_req, res) => res.end('{}')))
    const http = createElasticTransport({ mode: 'pinned', fingerprint: 'AA:'.repeat(31) + 'AA' })
    const error = await failure(http({ method: 'POST', url: `https://127.0.0.1:${port}/x/_count`, headers: {}, body: '{}', timeoutMs: 2000 }))
    expect(error).toBeInstanceOf(ElasticError)
    expect((error as ElasticError).kind).toBe('untrustedCertificate')
  })

  it('rejects a self-signed cluster under the system trust store', async () => {
    const port = await listen(createHttpsServer({ cert, key }, (_req, res) => res.end('{}')))
    const http = createElasticTransport({ mode: 'system' })
    const error = await failure(http({ method: 'POST', url: `https://127.0.0.1:${port}/x/_count`, headers: {}, body: '{}', timeoutMs: 2000 }))
    expect(classifyNetworkError(error, 2000).kind).toBe('untrustedCertificate')
  })
})
