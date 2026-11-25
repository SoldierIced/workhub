// The Workhub control endpoint, reached from inside a host's environment (a WSL distribution): the
// host listens on a Unix socket of its own and relays every HTTP request on it to the app over the
// host channel, where main serves (and authorizes) it like a request to its own endpoint. No
// network path from the host to the app is needed.
//
// The channel's requests go from the app to the host only, so the relay rides on what exists:
//   host → app   event   `control.request`  {rid, method, url, headers, body}
//   app → host   request `control.respond`  {rid, status, headers, body}   → {delivered}
// A request the app does not answer in time gets a 504, one over the cap a 413, and one past the
// limit of requests waiting at once a 503. The host never decides who may do what.
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmdirSync, unlinkSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { HostHandlerError, type HostHandlers } from './server'

export const CONTROL_REQUEST_EVENT = 'control.request'
export const CONTROL_RESPOND_METHOD = 'control.respond'
/** Where the host's endpoint and Workhub's MCP server are (`HostInfo`). */
export const HOST_INFO_METHOD = 'host.info'

/** The largest request body relayed, in bytes: the app's endpoint reads no more. */
export const CONTROL_RELAY_MAX_BODY = 256 * 1024
/** How long a relayed request waits for the app's answer. */
export const CONTROL_RELAY_TIMEOUT_MS = 30_000
/** Requests waiting for the app at once; more get a 503. */
export const CONTROL_RELAY_MAX_PENDING = 64
/** Unix socket paths are cut at about 104 bytes (macOS); longer ones are not used. */
const MAX_SOCKET_PATH = 100

const headersSchema = z.record(z.string(), z.string())

export const relayedControlRequestSchema = z.object({
  rid: z.number().int().nonnegative(),
  method: z.string().min(1).max(16),
  url: z.string().max(8192),
  headers: headersSchema,
  body: z.string()
})
export type RelayedControlRequest = z.infer<typeof relayedControlRequestSchema>

export const relayedControlResponseSchema = z.object({
  rid: z.number().int().nonnegative(),
  status: z.number().int().min(100).max(599),
  headers: headersSchema,
  body: z.string()
})
export type RelayedControlResponse = z.infer<typeof relayedControlResponseSchema>

/** What `host.info` answers: the host's endpoint socket (null when it has none) and how to run the MCP server there. */
export interface HostInfo {
  control: { socket: string } | null
  /** The Node the host runs on (Electron as Node for the child host: run it with ELECTRON_RUN_AS_NODE). */
  node: string
  /** `workhub-mcp.mjs` in the host's bridge folder. */
  mcpScript: string
}

export const hostInfoSchema = z.object({
  control: z.object({ socket: z.string().min(1) }).nullable(),
  node: z.string().min(1),
  mcpScript: z.string().min(1)
})

const JSON_HEADERS = { 'content-type': 'application/json' }

function fail(res: ServerResponse, status: number, error: string, close = false): void {
  if (res.headersSent) return
  res.writeHead(status, close ? { ...JSON_HEADERS, connection: 'close' } : JSON_HEADERS)
  res.end(JSON.stringify({ ok: false, error }))
}

/** Header values as strings (repeated ones joined), so they cross the channel as plain JSON. */
function flatHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') out[key] = value
    else if (Array.isArray(value)) out[key] = value.join(', ')
  }
  return out
}

/**
 * A folder for the host's socket that only the user can open: `$XDG_RUNTIME_DIR/workhub` when that
 * is set and the user's, else a new random folder in the temp folder (or in `/tmp` when the temp
 * folder's path is too long). `created` is the folder to remove on exit, when it was made here.
 */
export function hostSocketDir(env: NodeJS.ProcessEnv = process.env, tmp: string = tmpdir()): { dir: string; created: string | null } {
  const room = (dir: string) => Buffer.byteLength(join(dir, 'host-4294967295.sock')) <= MAX_SOCKET_PATH
  const runtime = env['XDG_RUNTIME_DIR']
  if (runtime && isAbsolute(runtime)) {
    const dir = join(runtime, 'workhub')
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const st = lstatSync(dir)
      const mine = typeof process.getuid !== 'function' || st.uid === process.getuid()
      if (st.isDirectory() && !st.isSymbolicLink() && mine && room(dir)) {
        chmodSync(dir, 0o700)
        return { dir, created: null }
      }
    } catch {
      /* the temp folder below */
    }
  }
  const base = room(join(tmp, 'workhub-host-XXXXXX')) ? tmp : '/tmp'
  const dir = mkdtempSync(join(base, 'workhub-host-'))
  return { dir, created: dir }
}

/** This process's socket in a folder from `hostSocketDir`: one per host process. */
export const hostSocketPath = (dir: string, pid: number = process.pid) => join(dir, `host-${pid}.sock`)

export interface ControlRelayOptions {
  /** Sends an event to the app (`HostServer.emit`); throws when the payload exceeds the line cap. */
  emit: (event: string, payload: unknown) => boolean
  timeoutMs?: number
  maxPending?: number
  maxBody?: number
  log?: (message: string) => void
}

interface Waiting {
  res: ServerResponse
  timer: ReturnType<typeof setTimeout>
}

/** The host's end of the relay: the socket's HTTP server, and the `control.respond` handler. */
export class ControlRelay {
  private server: Server | undefined
  private path: string | null = null
  private ownedDir: string | null = null
  private nextRid = 1
  private closed = false
  private readonly waiting = new Map<number, Waiting>()

  constructor(private readonly options: ControlRelayOptions) {}

  /** The socket's path once it listens; null before, after `close`, or when it could not listen. */
  get socketPath(): string | null {
    return this.path
  }

  /** The handlers to add to the host's (`control.respond`). */
  get handlers(): HostHandlers {
    return {
      [CONTROL_RESPOND_METHOD]: (params) => {
        const parsed = relayedControlResponseSchema.safeParse(params)
        if (!parsed.success) throw new HostHandlerError('bad_params', 'a control response needs rid, status, headers and body')
        return { delivered: this.answer(parsed.data) }
      }
    }
  }

  /**
   * Listens on `socketPath` (mode 0600). A file already there is replaced: the path carries this
   * process's id, in a folder only the user can open. `ownedDir` is removed on close.
   */
  listen(socketPath: string, ownedDir: string | null = null): Promise<void> {
    if (this.closed) return Promise.reject(new Error('the relay is closed'))
    if (existsSync(socketPath)) unlinkSync(socketPath)
    const server = createServer((req, res) => this.receive(req, res))
    this.server = server
    this.ownedDir = ownedDir
    return new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, () => {
        server.off('error', reject)
        server.on('error', (err) => this.options.log?.(`control socket: ${err.message}`))
        try {
          chmodSync(socketPath, 0o600)
        } catch (err) {
          server.close()
          reject(err)
          return
        }
        if (this.closed) {
          server.close()
          this.removeFiles(socketPath)
          reject(new Error('the relay is closed'))
          return
        }
        this.path = socketPath
        resolve()
      })
    })
  }

  /** Stops listening, answers the waiting requests with 503 and removes the socket file. */
  close(): void {
    if (this.closed) return
    this.closed = true
    for (const [rid, w] of this.waiting) {
      clearTimeout(w.timer)
      fail(w.res, 503, 'the Workhub host is shutting down')
      this.waiting.delete(rid)
    }
    this.server?.close()
    this.server?.closeAllConnections()
    const path = this.path
    this.path = null
    if (path) this.removeFiles(path)
  }

  private removeFiles(path: string): void {
    try {
      unlinkSync(path)
    } catch {
      /* already gone */
    }
    if (this.ownedDir) {
      try {
        rmdirSync(this.ownedDir)
      } catch {
        /* not empty or gone: left alone */
      }
    }
  }

  private receive(req: IncomingMessage, res: ServerResponse): void {
    const maxBody = this.options.maxBody ?? CONTROL_RELAY_MAX_BODY
    const chunks: Buffer[] = []
    let size = 0
    let refused = false
    req.on('data', (chunk: Buffer) => {
      if (refused) return
      size += chunk.length
      if (size > maxBody) {
        refused = true
        chunks.length = 0
        // The rest is read and dropped; the connection closes after the answer.
        fail(res, 413, `the body is larger than ${maxBody} bytes`, true)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!refused) this.forward(req, res, Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', () => res.destroy())
  }

  private forward(req: IncomingMessage, res: ServerResponse, body: string): void {
    if (this.closed) return fail(res, 503, 'the Workhub host is shutting down')
    if (this.waiting.size >= (this.options.maxPending ?? CONTROL_RELAY_MAX_PENDING)) return fail(res, 503, 'too many requests wait for Workhub; try again')
    const rid = this.nextRid++
    const request: RelayedControlRequest = { rid, method: req.method ?? 'GET', url: req.url ?? '/', headers: flatHeaders(req), body }
    const timeoutMs = this.options.timeoutMs ?? CONTROL_RELAY_TIMEOUT_MS
    const timer = setTimeout(() => {
      this.waiting.delete(rid)
      fail(res, 504, `Workhub did not answer within ${timeoutMs} ms`)
    }, timeoutMs)
    this.waiting.set(rid, { res, timer })
    // A client that hangs up stops waiting.
    res.on('close', () => {
      const w = this.waiting.get(rid)
      if (w?.res !== res) return
      clearTimeout(w.timer)
      this.waiting.delete(rid)
    })
    try {
      this.options.emit(CONTROL_REQUEST_EVENT, request)
    } catch (err) {
      // Only a payload over the channel's line cap throws (a body of escaped characters).
      clearTimeout(timer)
      this.waiting.delete(rid)
      fail(res, 413, `the request is too large to relay: ${(err as Error).message}`)
    }
  }

  private answer(r: RelayedControlResponse): boolean {
    const w = this.waiting.get(r.rid)
    if (!w) return false
    clearTimeout(w.timer)
    this.waiting.delete(r.rid)
    if (w.res.headersSent || w.res.destroyed) return false
    w.res.writeHead(r.status, r.headers)
    w.res.end(r.body)
    return true
  }
}
