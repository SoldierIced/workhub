import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { classifyNetworkError, createElasticTransport } from '../src/health-elastic'

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
})
