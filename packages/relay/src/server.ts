// The relay as a process: HTTP (health, the web client) and WebSocket on one port, behind a reverse
// proxy that terminates TLS. Sockets that never authenticate are closed after `authTimeoutMs`;
// idle ones are pinged so a dead phone connection is noticed.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
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

/**
 * The client's address. Behind a trusted proxy that is `X-Real-IP`, or the LAST entry of
 * `X-Forwarded-For` (the one the proxy appended; the client can write whatever it likes before it).
 */
export function addressOf(req: Pick<IncomingMessage, 'headers' | 'socket'>, trustProxy: boolean): string {
  if (trustProxy) {
    const real = req.headers['x-real-ip']
    const realOne = Array.isArray(real) ? real[0] : real
    if (realOne?.trim()) return realOne.trim()
    const forwarded = req.headers['x-forwarded-for']
    const joined = Array.isArray(forwarded) ? forwarded.join(',') : forwarded
    const last = joined?.split(',').map((s) => s.trim()).filter(Boolean).pop()
    if (last) return last
  }
  return req.socket.remoteAddress ?? 'unknown'
}

/**
 * The web client's policy, as headers: the page's own `<meta>` cannot carry `frame-ancestors`.
 * Connections stay open to any wss/https host because a phone may pair with desktops on other relays.
 */
const CONTENT_SECURITY_POLICY = "default-src 'self'; connect-src 'self' wss: https:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

function securityHeaders(res: ServerResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY)
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()')
}

/** The largest frame the socket buffers; above it the socket is closed. The core's own limit is lower. */
export const TRANSPORT_FRAME_LIMIT_BYTES = 8 * 1024 * 1024

export function createRelayServer(options: RelayServerOptions = {}): RelayServer {
  const core = new RelayCore(options)
  const authTimeoutMs = options.authTimeoutMs ?? 10_000
  const heartbeatMs = options.heartbeatMs ?? 30_000
  const trustProxy = options.trustProxy ?? false

  const http = createServer((req, res) => {
    try {
      securityHeaders(res)
      const path = (req.url ?? '/').split('?')[0]
      if (path === '/healthz') {
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.setHeader('Cache-Control', 'no-store')
        res.end(JSON.stringify({ ok: true, version: options.version ?? 'dev', push: Boolean(options.push) }))
        return
      }
      if (options.webClientDir && (req.method === 'GET' || req.method === 'HEAD') && serveStatic(options.webClientDir, req, res)) return
      res.statusCode = 404
      res.setHeader('Content-Type', 'text/plain; charset=utf-8')
      res.end('not found')
    } catch (err) {
      options.log?.warn(`request failed: ${err instanceof Error ? err.message : String(err)}`)
      if (!res.headersSent) res.statusCode = 500
      res.end()
    }
  })

  // `ws` closes a frame above maxPayload itself (1009), before it is buffered whole. That ceiling is
  // well above the protocol's frame limit: an oversized frame from a peer is answered by the core
  // with a `too-large` error and dropped, and the peer stays connected. Closing it instead put a
  // desktop that answered with one oversized frame into a reconnect loop with its phone.
  const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: TRANSPORT_FRAME_LIMIT_BYTES })
  const alive = new WeakMap<WebSocket, boolean>()

  wss.on('connection', (socket, req) => {
    const peer: Peer | null = core.connect({ send: (text) => socket.send(text), close: (code, reason) => socket.close(code, reason), buffered: () => socket.bufferedAmount }, addressOf(req, trustProxy))
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
