/**
 * The local control endpoint: lets tools an agent runs inside a Workhub session ask Workhub for
 * something: "open the human review of my changes", store a flow map, read and update the plan.
 *
 * On macOS and Linux it is HTTP over a Unix socket in the data folder, so only the user's own
 * processes reach it; every session gets `WORKHUB_SESSION` (its id) and `WORKHUB_SOCKET` (the path).
 * On Windows Node cannot serve a Unix socket and curl cannot talk to a named pipe, so it is HTTP on
 * a random loopback port guarded by a token made at each launch: sessions get `WORKHUB_URL` and
 * `WORKHUB_TOKEN` instead, and every request sends `Authorization: Bearer $WORKHUB_TOKEN`. The
 * `workhub-*` skills pick whichever the session has.
 *
 *   curl --unix-socket "$WORKHUB_SOCKET" -X POST "http://workhub/v1/sessions/$WORKHUB_SESSION/review" \
 *     -H 'content-type: application/json' -d '{"repos":[{"path":"/abs/repo","base":"origin/main"}]}'
 *
 * It also takes a flow map (the Flow maps screen), validated and stored in the data folder:
 *
 *   curl --unix-socket "$WORKHUB_SOCKET" -X POST http://workhub/v1/flow-maps \
 *     -H 'content-type: application/json' --data-binary @checkout.flow-map.json
 *
 * And it takes proposals for Plan's inbox (pending items the user approves, keeps or discards):
 *
 *   curl --unix-socket "$WORKHUB_SOCKET" -X POST http://workhub/v1/inbox \
 *     -H 'content-type: application/json' \
 *     -d '{"session":"'"$WORKHUB_SESSION"'","items":[{"kind":"task","title":"Send the rollout plan","detail":"Agreed in the sync","people":["ana@example.com"],"due":"2026-11-05"}]}'
 *
 * And it lets an agent read and update its profile's plan (`plan-control.ts`; the `workhub-plan` skill):
 *
 *   curl --unix-socket "$WORKHUB_SOCKET" "http://workhub/v1/plan/today?session=$WORKHUB_SESSION"
 *   curl --unix-socket "$WORKHUB_SOCKET" "http://workhub/v1/inbox?session=$WORKHUB_SESSION&status=local"
 *   curl --unix-socket "$WORKHUB_SOCKET" -X PATCH "http://workhub/v1/inbox/<id>" \
 *     -H 'content-type: application/json' -d '{"session":"'"$WORKHUB_SESSION"'","status":"done"}'
 *   curl --unix-socket "$WORKHUB_SOCKET" "http://workhub/v1/milestones?session=$WORKHUB_SESSION"
 *   curl --unix-socket "$WORKHUB_SOCKET" "http://workhub/v1/people?session=$WORKHUB_SESSION"
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, statSync, unlinkSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { PlanControl } from './plan-control'

const MAX_BODY = 256 * 1024
const MAX_REPOS = 20

export interface ReviewRequestRepo {
  path: string
  base?: string
}

/** A whole answer: its HTTP status and JSON body. */
export interface ControlReply {
  status: number
  body: Record<string, unknown>
}

export type ControlResult = { ok: true } | { ok: false; status: number; error: string }

export interface ControlDeps {
  /** Opens the session's "Review changes" window on these repos (plus the ones it finds itself). */
  openReview(sessionId: string, repos: ReviewRequestRepo[]): ControlResult
  /** Validates and stores a flow map (the Flow maps screen); errors name the fields. */
  saveFlowMap?(map: unknown): { ok: true; file: string; id: string } | { ok: false; errors: string[] }
  /** Adds the items of a body to a profile's inbox as pending (`parseInboxProposals` checks it). */
  addInboxItems?(body: unknown): Promise<{ ok: true; added: string[]; duplicates: string[] } | { ok: false; status: number; error: string }>
  /** Plan for agents: today's meetings, reading and updating the inbox, milestones, people. */
  plan?: PlanControl
  log?: (message: string) => void
}

/** Unix socket paths are cut at about 104 bytes (macOS); a path longer than this is not used. */
const MAX_SOCKET_PATH = 100

/**
 * Where the socket endpoint listens for a data folder: a socket file in it (macOS and Linux). On
 * Windows it is a named pipe, which Node serves but curl cannot reach, so the app uses the loopback
 * endpoint there (`startLoopbackControlServer`); the pipe stays for tests and Node clients.
 * A data folder too long for a socket path falls back to a folder only the user can open
 * (`privateSocketDir`), made only when it is needed.
 */
export function controlSocketPath(dataDir: string, platform: NodeJS.Platform = process.platform, fallbackDir: () => string = privateSocketDir): string {
  const hash = createHash('sha256').update(dataDir).digest('hex').slice(0, 16)
  if (platform === 'win32') return `\\\\.\\pipe\\workhub-control-${hash}`
  const inData = join(dataDir, 'control.sock')
  return Buffer.byteLength(inData) <= MAX_SOCKET_PATH ? inData : join(fallbackDir(), `workhub-control-${hash}.sock`)
}

/**
 * A folder for the socket that only the user can open (0700), so no other user can predict the
 * path and take it first: `$XDG_RUNTIME_DIR/workhub` when that is set (and owned by the user),
 * else a new random folder in the temp folder, else one in `/tmp` when the temp folder's path is
 * too long for a socket.
 */
export function privateSocketDir(env: NodeJS.ProcessEnv = process.env, tmp: string = tmpdir()): string {
  const room = (dir: string) => Buffer.byteLength(join(dir, 'workhub-control-0123456789abcdef.sock')) <= MAX_SOCKET_PATH
  const runtime = env['XDG_RUNTIME_DIR']
  if (runtime && isAbsolute(runtime)) {
    const dir = join(runtime, 'workhub')
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const st = lstatSync(dir)
      const mine = typeof process.getuid !== 'function' || st.uid === process.getuid()
      if (st.isDirectory() && !st.isSymbolicLink() && mine && room(dir)) {
        chmodSync(dir, 0o700)
        return dir
      }
    } catch {
      /* the temp folder below */
    }
  }
  // mkdtemp makes the folder 0700 with a random name.
  const base = room(join(tmp, 'workhub-XXXXXX')) ? tmp : '/tmp'
  return mkdtempSync(join(base, 'workhub-'))
}

/** The variables of the endpoint; a session gets all of them, the unused ones empty. */
export const CONTROL_ENV_KEYS = ['WORKHUB_SESSION', 'WORKHUB_SOCKET', 'WORKHUB_URL', 'WORKHUB_TOKEN'] as const

/**
 * The environment of a session that must not reach any endpoint (a reviewer, or no endpoint is
 * up): every variable set empty, so values inherited from a parent process (a Workhub started from
 * a session of another Workhub) never point it at the other app.
 */
export const NO_CONTROL_ENV: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(CONTROL_ENV_KEYS.map((k) => [k, ''])))

/** How sessions reach the endpoint: the socket path, or the loopback URL and its token (Windows); null before it listens. */
export type ControlEndpoint = { socket: string } | { url: string; token: string }

/** Whether this platform serves the endpoint on a loopback port with a token instead of a Unix socket. */
export const usesLoopbackControl = (platform: NodeJS.Platform = process.platform) => platform === 'win32'

/** A new token for the loopback endpoint (one per launch). */
export const newControlToken = () => randomBytes(32).toString('hex')

/** The environment a session gets to reach the endpoint; `NO_CONTROL_ENV` while none listens. */
export function controlEnv(sessionId: string, endpoint: ControlEndpoint | null): Record<string, string> {
  if (!endpoint) return { ...NO_CONTROL_ENV }
  if ('socket' in endpoint) return { ...NO_CONTROL_ENV, WORKHUB_SESSION: sessionId, WORKHUB_SOCKET: endpoint.socket }
  return { ...NO_CONTROL_ENV, WORKHUB_SESSION: sessionId, WORKHUB_URL: endpoint.url, WORKHUB_TOKEN: endpoint.token }
}

/** True when the request carries `Authorization: Bearer <token>` (compared in constant time). */
export function hasControlToken(req: Pick<IncomingMessage, 'headers'>, token: string): boolean {
  const header = req.headers.authorization ?? ''
  const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7).trim() : '')
  const want = Buffer.from(token)
  return given.length === want.length && timingSafeEqual(given, want)
}

/** The repos of a review request, checked one by one; a string when the body is not one. */
export function parseReviewBody(body: unknown, isDir: (path: string) => boolean): ReviewRequestRepo[] | string {
  if (body === undefined || body === null) return []
  if (typeof body !== 'object') return 'the body must be a JSON object'
  const repos = (body as { repos?: unknown }).repos
  if (repos === undefined) return []
  if (!Array.isArray(repos)) return '"repos" must be an array'
  if (repos.length > MAX_REPOS) return `at most ${MAX_REPOS} repos`
  const out: ReviewRequestRepo[] = []
  for (const r of repos) {
    const path = typeof r === 'string' ? r : r && typeof r === 'object' ? (r as { path?: unknown }).path : undefined
    const base = r && typeof r === 'object' ? (r as { base?: unknown }).base : undefined
    if (typeof path !== 'string' || !isAbsolute(path)) return 'every repo needs an absolute "path"'
    if (!isDir(path)) return `not a folder: ${path}`
    if (base !== undefined && (typeof base !== 'string' || !/^[\w./-]{1,200}$/.test(base))) return `bad "base" for ${path}`
    out.push({ path, ...(typeof base === 'string' && base ? { base } : {}) })
  }
  return out
}

const isDirectory = (path: string) => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function reply(res: ServerResponse, r: ControlReply): void {
  send(res, r.status, r.body)
}

/** The read-only Plan endpoints and the handler of each. */
const PLAN_READS: Record<string, 'today' | 'milestones' | 'people'> = { '/v1/plan/today': 'today', '/v1/milestones': 'milestones', '/v1/people': 'people' }

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY) throw new Error('body too large')
    chunks.push(chunk as Buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  return text ? JSON.parse(text) : undefined
}

/** Handles one request; exported for tests. */
export async function handleControl(deps: ControlDeps, req: IncomingMessage, res: ServerResponse, isDir: (path: string) => boolean = isDirectory): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://workhub')
  if (req.method === 'GET' && url.pathname === '/v1/health') return send(res, 200, { ok: true })
  if (url.pathname === '/v1/flow-maps') {
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'use POST' })
    if (!deps.saveFlowMap) return send(res, 404, { ok: false, error: 'flow maps are not available' })
    let body: unknown
    try {
      body = await readJson(req)
    } catch (e) {
      return send(res, 400, { ok: false, error: e instanceof Error ? e.message : 'bad body' })
    }
    const saved = deps.saveFlowMap(body)
    return saved.ok ? send(res, 200, saved) : send(res, 400, { ok: false, error: saved.errors.join('; '), errors: saved.errors })
  }
  if (url.pathname === '/v1/inbox') {
    if (req.method === 'GET') return deps.plan ? reply(res, await deps.plan.inbox(url.searchParams)) : send(res, 404, { ok: false, error: 'the inbox is not available' })
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'use GET or POST' })
    if (!deps.addInboxItems) return send(res, 404, { ok: false, error: 'the inbox is not available' })
    let body: unknown
    try {
      body = await readJson(req)
    } catch (e) {
      return send(res, 400, { ok: false, error: e instanceof Error ? e.message : 'bad body' })
    }
    const added = await deps.addInboxItems(body)
    return added.ok ? send(res, 200, added) : send(res, added.status, { ok: false, error: added.error })
  }
  const item = /^\/v1\/inbox\/([^/]{1,200})$/.exec(url.pathname)
  if (item) {
    if (req.method !== 'PATCH') return send(res, 405, { ok: false, error: 'use PATCH' })
    if (!deps.plan) return send(res, 404, { ok: false, error: 'the inbox is not available' })
    let body: unknown
    try {
      body = await readJson(req)
    } catch (e) {
      return send(res, 400, { ok: false, error: e instanceof Error ? e.message : 'bad body' })
    }
    let id: string
    try {
      id = decodeURIComponent(item[1]!)
    } catch {
      return send(res, 400, { ok: false, error: 'bad item id' })
    }
    return reply(res, await deps.plan.updateItem(id, body, url.searchParams))
  }
  const milestone = url.pathname === '/v1/milestones' ? null : /^\/v1\/milestones\/([^/]{1,200})$/.exec(url.pathname)
  if ((url.pathname === '/v1/milestones' && req.method === 'POST') || milestone) {
    if (!deps.plan) return send(res, 404, { ok: false, error: 'Plan is not available' })
    const method = req.method
    if (milestone ? method !== 'PATCH' && method !== 'DELETE' : method !== 'POST') return send(res, 405, { ok: false, error: milestone ? 'use PATCH or DELETE' : 'use GET or POST' })
    let body: unknown
    try {
      body = await readJson(req)
    } catch (e) {
      return send(res, 400, { ok: false, error: e instanceof Error ? e.message : 'bad body' })
    }
    let id: string | null = null
    if (milestone) {
      try {
        id = decodeURIComponent(milestone[1]!)
      } catch {
        return send(res, 400, { ok: false, error: 'bad milestone id' })
      }
    }
    return reply(res, await deps.plan.changeMilestone(id, method as 'POST' | 'PATCH' | 'DELETE', body, url.searchParams))
  }
  const read = Object.hasOwn(PLAN_READS, url.pathname) ? PLAN_READS[url.pathname] : undefined
  if (read) {
    if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'use GET' })
    if (!deps.plan) return send(res, 404, { ok: false, error: 'Plan is not available' })
    return reply(res, await deps.plan[read](url.searchParams))
  }
  const review = /^\/v1\/sessions\/([\w-]{1,100})\/review$/.exec(url.pathname)
  if (!review) return send(res, 404, { ok: false, error: 'unknown endpoint' })
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'use POST' })
  let body: unknown
  try {
    body = await readJson(req)
  } catch (e) {
    return send(res, 400, { ok: false, error: e instanceof Error ? e.message : 'bad body' })
  }
  const repos = parseReviewBody(body, isDir)
  if (typeof repos === 'string') return send(res, 400, { ok: false, error: repos })
  const result = deps.openReview(review[1]!, repos)
  if (!result.ok) return send(res, result.status, { ok: false, error: result.error })
  return send(res, 200, { ok: true })
}

/**
 * What is at a socket path: `live` when something accepts a connection (another Workhub serves
 * it), `stale` when nothing is there or nothing listens (a socket left by a crash), `unknown` for
 * anything else (no permission, not a socket, no answer in time). Only a stale one may be removed.
 */
export function probeSocket(socketPath: string, timeoutMs = 1000): Promise<'live' | 'stale' | 'unknown'> {
  return new Promise((resolve) => {
    const socket = connect(socketPath)
    const done = (state: 'live' | 'stale' | 'unknown') => {
      clearTimeout(timer)
      socket.destroy()
      resolve(state)
    }
    const timer = setTimeout(() => done('unknown'), timeoutMs)
    socket.once('connect', () => done('live'))
    socket.once('error', (e: NodeJS.ErrnoException) => done(e.code === 'ECONNREFUSED' || e.code === 'ENOENT' ? 'stale' : 'unknown'))
  })
}

/**
 * Starts the endpoint. A stale socket left by a crash is replaced; one another process still
 * serves (a second Workhub on the same data folder) is left alone. Resolves to null when it cannot listen.
 */
export async function startControlServer(socketPath: string, deps: ControlDeps): Promise<Server | null> {
  if (process.platform !== 'win32' && existsSync(socketPath)) {
    const state = await probeSocket(socketPath)
    if (state !== 'stale') {
      deps.log?.(`control endpoint not started: ${socketPath} is ${state === 'live' ? 'served by another process' : 'in use or not reachable'}`)
      return null
    }
    try {
      unlinkSync(socketPath)
    } catch {
      /* listen reports it */
    }
  }
  const server = createServer((req, res) => {
    handleControl(deps, req, res).catch((e: unknown) => send(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) }))
  })
  return new Promise((resolve) => {
    server.once('error', (e) => {
      deps.log?.(`control endpoint not started: ${e.message}`)
      resolve(null)
    })
    server.listen(socketPath, () => {
      if (process.platform !== 'win32') {
        try {
          chmodSync(socketPath, 0o600)
        } catch {
          /* the data folder is the user's own */
        }
      }
      resolve(server)
    })
  })
}

/**
 * Starts the endpoint on a random port of 127.0.0.1, answering only requests with the token
 * (Windows). A request a browser page sends carries an `Origin` and is refused too, so a web page
 * cannot use the port even if it guessed the token. Resolves to null when it cannot listen.
 */
export function startLoopbackControlServer(token: string, deps: ControlDeps): Promise<{ server: Server; url: string } | null> {
  const server = createServer((req, res) => {
    if (req.headers.origin !== undefined || !hasControlToken(req, token)) return send(res, 401, { ok: false, error: 'missing or wrong token: send Authorization: Bearer $WORKHUB_TOKEN' })
    handleControl(deps, req, res).catch((e: unknown) => send(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) }))
  })
  return new Promise((resolve) => {
    server.once('error', (e) => {
      deps.log?.(`control endpoint not started: ${e.message}`)
      resolve(null)
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        resolve(null)
        return
      }
      resolve({ server, url: `http://127.0.0.1:${address.port}` })
    })
  })
}
