// The relay as a process: HTTP (health, the web client) and WebSocket on one port, behind a reverse
// proxy that terminates TLS. Sockets that never authenticate are closed after `authTimeoutMs`;
// idle ones are pinged so a dead phone connection is noticed.
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { RelayCore, type Peer, type RelayCoreOptions } from './core'
import { serveStatic } from './static'

export interface RelayServerOptions extends RelayCoreOptions {
  /** Where the web client's built files are; unset serves none. */
  webClientDir?: string
  authTimeoutMs?: number
  heartbeatMs?: number
  /** Trust `X-Forwarded-For` from the proxy in front (true behind nginx). */
  trustProxy?: boolean
  version?: string
}

export interface RelayServer {
  http: Server
  core: RelayCore
  close(): Promise<void>
}

function addressOf(req: IncomingMessage, trustProxy: boolean): string {
  const forwarded = trustProxy ? req.headers['x-forwarded-for'] : undefined
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0]
  return (first ?? req.socket.remoteAddress ?? 'unknown').trim()
}

export function createRelayServer(options: RelayServerOptions = {}): RelayServer {
  const core = new RelayCore(options)
  const authTimeoutMs = options.authTimeoutMs ?? 10_000
  const heartbeatMs = options.heartbeatMs ?? 30_000
  const trustProxy = options.trustProxy ?? true
  const startedAt = Date.now()

  const http = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]
    if (path === '/healthz') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      res.end(JSON.stringify({ ok: true, version: options.version ?? 'dev', uptimeSeconds: Math.round((Date.now() - startedAt) / 1000), push: Boolean(options.push) }))
      return
    }
    if (options.webClientDir && (req.method === 'GET' || req.method === 'HEAD') && serveStatic(options.webClientDir, req, res)) return
    res.statusCode = 404
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.end('not found')
  })

  const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: 2 * 1024 * 1024 })
  const alive = new WeakMap<WebSocket, boolean>()

  wss.on('connection', (socket, req) => {
    const peer: Peer | null = core.connect({ send: (text) => socket.send(text), close: (code, reason) => socket.close(code, reason) }, addressOf(req, trustProxy))
    if (!peer) return
    alive.set(socket, true)
    const authTimer = setTimeout(() => {
      if (!core.isAuthenticated(peer)) socket.close(1008, 'auth timeout')
    }, authTimeoutMs)
    socket.on('message', (data, isBinary) => {
      const raw = isBinary ? new Uint8Array(data as Buffer) : (data as Buffer).toString('utf8')
      core.receive(peer, raw)
    })
    socket.on('pong', () => alive.set(socket, true))
    socket.on('close', () => {
      clearTimeout(authTimer)
      core.disconnect(peer)
    })
    socket.on('error', () => socket.close())
  })

  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (alive.get(socket) === false) {
        socket.terminate()
        continue
      }
      alive.set(socket, false)
      socket.ping()
    }
  }, heartbeatMs)

  return {
    http,
    core,
    close: () =>
      new Promise((done) => {
        clearInterval(heartbeat)
        for (const socket of wss.clients) socket.close(1001, 'relay shutting down')
        wss.close(() => http.close(() => done()))
      })
  }
}
