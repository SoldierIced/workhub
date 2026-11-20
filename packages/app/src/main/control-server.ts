/**
 * The local control endpoint: lets tools an agent runs inside a Workhub session ask Workhub for
 * something: "open the human review of my changes", store a flow map, read and update the plan.
 *
 * On macOS and Linux it is HTTP over a Unix socket in the data folder, so only the user's own
 * processes reach it; every session gets `WORKHUB_SESSION` (its id) and `WORKHUB_SOCKET` (the path).
 * On Windows Node cannot serve a Unix socket and curl cannot talk to a named pipe, so it is HTTP on
 * a random loopback port guarded by a token made at each launch: sessions get `WORKHUB_URL` and
 * `WORKHUB_TOKEN` instead, and every request sends `Authorization: Bearer $WORKHUB_TOKEN`. The
 * `workhub-*` skills pick whichever the session has. A session on another host (a WSL
 * distribution) gets `WORKHUB_SOCKET` naming a socket of that host, which relays each request to
 * `serveControl` here over the host channel (`host-control.ts`), even when the app runs on Windows.
 *
 * Reaching the endpoint does not say which session is calling: every session also gets its own
 * token, `WORKHUB_SESSION_TOKEN`, sent as `X-Workhub-Token`, and a request acts as the session of
 * its token only (`control-auth.ts`). Without one, only reads of the active profile's plan and
 * automations are answered. The examples below leave the header out for brevity:
 *
 *   -H "X-Workhub-Token: $WORKHUB_SESSION_TOKEN"
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
 *
 * And it lets an agent read, add and edit automations and read past sessions
 * (`automation-control.ts`; the `workhub-automations` skill). What an agent adds or edits stays off
 * until the user turns it on:
 *
 *   curl --unix-socket "$WORKHUB_SOCKET" "http://workhub/v1/automations?session=$WORKHUB_SESSION"
 *   curl --unix-socket "$WORKHUB_SOCKET" -X POST http://workhub/v1/automations \
 *     -H 'content-type: application/json' -d '{"session":"'"$WORKHUB_SESSION"'","automation":{"name":"Triage","prompt":"/triage"}}'
 *   curl --unix-socket "$WORKHUB_SOCKET" -X PATCH "http://workhub/v1/automations/<id>" \
 *     -H 'content-type: application/json' -d '{"session":"'"$WORKHUB_SESSION"'","automation":{"triggers":{"intervalMinutes":30}}}'
 *   curl --unix-socket "$WORKHUB_SOCKET" "http://workhub/v1/history?session=$WORKHUB_SESSION&q=deploy"
 *   curl --unix-socket "$WORKHUB_SOCKET" "http://workhub/v1/history/claude/<agent-session-id>?session=$WORKHUB_SESSION"
 *
 * And it lets an agent read the usage database, read-only (`analytics-control.ts`; the
 * `workhub-analytics` skill):
 *
 *   curl --unix-socket "$WORKHUB_SOCKET" "http://workhub/v1/analytics/schema?session=$WORKHUB_SESSION"
 *   curl --unix-socket "$WORKHUB_SOCKET" -X POST http://workhub/v1/analytics/query \
 *     -H 'content-type: application/json' -d '{"session":"'"$WORKHUB_SESSION"'","sql":"SELECT cwd, TOTAL(usd) FROM turns GROUP BY cwd"}'
 *   curl --unix-socket "$WORKHUB_SOCKET" "http://workhub/v1/analytics/report?session=$WORKHUB_SESSION&kind=spend_by_project"
 *
 * And it lets an agent see the other sessions of its profile and, with the user's approval, start
 * or message one, and notify the user (`session-control.ts`; the `workhub-sessions` skill):
 *
 *   curl --unix-socket "$WORKHUB_SOCKET" "http://workhub/v1/sessions?session=$WORKHUB_SESSION"
 *   curl --unix-socket "$WORKHUB_SOCKET" -X POST http://workhub/v1/sessions \
 *     -H 'content-type: application/json' -d '{"agent":"claude","folder":"/abs/repo","prompt":"Write the tests"}'
 *   curl --unix-socket "$WORKHUB_SOCKET" -X POST "http://workhub/v1/sessions/<id>/message" \
 *     -H 'content-type: application/json' -d '{"text":"The API is merged"}'
 *   curl --unix-socket "$WORKHUB_SOCKET" -X POST http://workhub/v1/notify \
 *     -H 'content-type: application/json' -d '{"title":"Tests pass","body":"Ready for review"}'
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, statSync, unlinkSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import type { AnalyticsControl } from './analytics-control'
import { authorizeControl, bindBody, type ControlAuth, type ControlCaller } from './control-auth'
import type { AutomationControl } from './automation-control'
import type { PlanControl } from './plan-control'
import type { SessionControl } from './session-control'

/** The largest request body the endpoint reads, in bytes (a host's socket applies the same cap). */
export const MAX_CONTROL_BODY = 256 * 1024
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
  /** Who a request is, from its session token (`control-auth.ts`); every route but health goes through it. */
  auth: ControlAuth
  /** Opens the session's "Review changes" window on these repos (plus the ones it finds itself). */
  openReview(sessionId: string, repos: ReviewRequestRepo[]): ControlResult | Promise<ControlResult>
  /** Validates and stores a flow map (the Flow maps screen); errors name the fields. `file` is a display name (`<id>.json`): maps live in the database. */
  saveFlowMap?(map: unknown, caller?: ControlCaller): { ok: true; file: string; id: string; note?: string } | { ok: false; errors: string[] }
  /** Adds the items of a body to a profile's inbox as pending (`parseInboxProposals` checks it). */
  addInboxItems?(body: unknown): Promise<{ ok: true; added: string[]; duplicates: string[] } | { ok: false; status: number; error: string }>
  /** Plan for agents: today's meetings, reading and updating the inbox, milestones, people. */
  plan?: PlanControl
  /** Automations (list, add, edit; never turned on) and past sessions for agents. */
  automations?: AutomationControl
  /** Read-only analytics over the usage database (schema, one SELECT, the Usage reports); reviewers too. */
  analytics?: AnalyticsControl
  /** The other sessions of the caller's profile: list, propose one, message one, and notify the user (`session-control.ts`). */
  sessions?: SessionControl
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
export const CONTROL_ENV_KEYS = ['WORKHUB_SESSION', 'WORKHUB_SESSION_TOKEN', 'WORKHUB_SOCKET', 'WORKHUB_URL', 'WORKHUB_TOKEN'] as const

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

/**
 * The environment a session gets to reach the endpoint, with its own token (`mintToken`, called
 * only when an endpoint listens); `NO_CONTROL_ENV` while none listens.
 */
export function controlEnv(sessionId: string, endpoint: ControlEndpoint | null, mintToken: () => string): Record<string, string> {
  if (!endpoint) return { ...NO_CONTROL_ENV }
  const session = { WORKHUB_SESSION: sessionId, WORKHUB_SESSION_TOKEN: mintToken() }
  if ('socket' in endpoint) return { ...NO_CONTROL_ENV, ...session, WORKHUB_SOCKET: endpoint.socket }
  return { ...NO_CONTROL_ENV, ...session, WORKHUB_URL: endpoint.url, WORKHUB_TOKEN: endpoint.token }
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

/**
 * The first path of a review request that is not inside one of `roots` (the session's folder or
 * worktree and the folders of its profile), compared by real path so a symlink or `..` cannot
 * leave them; null when all are inside. A root that does not exist is skipped.
 */
export function reviewPathOutside(repos: readonly ReviewRequestRepo[], roots: readonly string[]): string | null {
  const real = (p: string): string | null => {
    try {
      return realpathSync(p)
    } catch {
      return null
    }
  }
  const allowed = roots.map(real).filter((r): r is string => r !== null)
  for (const { path } of repos) {
    const target = real(path)
    const inside = target !== null && allowed.some((root) => {
      const rel = relative(root, target)
      return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
    })
    if (!inside) return path
  }
  return null
}

const isDirectory = (path: string) => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

const JSON_HEADERS: Readonly<Record<string, string>> = Object.freeze({ 'content-type': 'application/json' })

/** One request to the endpoint as plain values: an HTTP request, or one a host relays from its socket. */
export interface ControlRequest {
  method: string
  /** The path and query (`/v1/plan/today?session=...`). */
  url: string
  headers: Record<string, string | string[] | undefined>
  /** The body as UTF-8 text; empty or absent when there is none. */
  body?: string
  /** The body passed MAX_CONTROL_BODY: a route that reads it answers 400. */
  bodyTooLarge?: boolean
}

/** One answer of the endpoint as plain values. */
export interface ControlResponse {
  status: number
  headers: Record<string, string>
  body: string
}

const json = (status: number, body: unknown): ControlResponse => ({ status, headers: { ...JSON_HEADERS }, body: JSON.stringify(body) })
const fromReply = (r: ControlReply): ControlResponse => json(r.status, r.body)

/**
 * The answer to a request whose route failed: a fixed message (what failed can carry the request's
 * own text, which is never echoed back); the detail goes to the log.
 */
function failed(deps: Pick<ControlDeps, 'log'>, res: ServerResponse, e: unknown): void {
  deps.log?.(`control endpoint: a request failed: ${e instanceof Error ? e.message : String(e)}`)
  send(res, json(500, { ok: false, error: 'internal error' }))
}

function send(res: ServerResponse, r: ControlResponse): void {
  res.writeHead(r.status, r.headers)
  res.end(r.body)
}

/** The read-only Plan endpoints and the handler of each. */
const PLAN_READS: Record<string, 'today' | 'milestones' | 'people'> = { '/v1/plan/today': 'today', '/v1/milestones': 'milestones', '/v1/people': 'people' }

/** The body of an HTTP request as text, up to MAX_CONTROL_BODY bytes. */
async function readText(req: IncomingMessage): Promise<{ body: string } | { tooLarge: true }> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_CONTROL_BODY) return { tooLarge: true }
    chunks.push(chunk as Buffer)
  }
  return { body: Buffer.concat(chunks).toString('utf8') }
}

/** The JSON body bound to the caller's session (`bindBody`), or the answer that refuses it. */
function readBody(req: ControlRequest, caller: ControlCaller): { ok: true; body: unknown } | { ok: false; status: number; error: string } {
  if (req.bodyTooLarge) return { ok: false, status: 400, error: 'body too large' }
  const text = (req.body ?? '').trim()
  let body: unknown
  try {
    body = text ? JSON.parse(text) : undefined
  } catch {
    // The parser's message quotes the body: never sent back.
    return { ok: false, status: 400, error: 'the body is not valid JSON' }
  }
  return bindBody(body, caller)
}

/**
 * Serves one request given as plain values: the core of the HTTP endpoints, and of the requests a
 * host relays from its socket (`host-control.ts`). Authorization happens here, in main, for both.
 */
export async function serveControl(deps: ControlDeps, req: ControlRequest, isDir: (path: string) => boolean = isDirectory): Promise<ControlResponse> {
  const url = new URL(req.url || '/', 'http://workhub')
  if (req.method === 'GET' && url.pathname === '/v1/health') return json(200, { ok: true })
  const who = authorizeControl(deps.auth, req, url, deps.log)
  if (!who.ok) return json(who.status, { ok: false, error: who.error })
  const caller = who.caller
  if (url.pathname === '/v1/flow-maps') {
    if (req.method !== 'POST') return json(405, { ok: false, error: 'use POST' })
    if (!deps.saveFlowMap) return json(404, { ok: false, error: 'flow maps are not available' })
    // The map itself is the body: no session is bound into it (the caller was checked above).
    const read = readBody(req, null)
    if (!read.ok) return json(read.status, { ok: false, error: read.error })
    const body = read.body
    const saved = deps.saveFlowMap(body, caller)
    return saved.ok ? json(200, saved) : json(400, { ok: false, error: saved.errors.join('; '), errors: saved.errors })
  }
  if (url.pathname === '/v1/inbox') {
    if (req.method === 'GET') return deps.plan ? fromReply(await deps.plan.inbox(url.searchParams)) : json(404, { ok: false, error: 'the inbox is not available' })
    if (req.method !== 'POST') return json(405, { ok: false, error: 'use GET or POST' })
    if (!deps.addInboxItems) return json(404, { ok: false, error: 'the inbox is not available' })
    const read = readBody(req, caller)
    if (!read.ok) return json(read.status, { ok: false, error: read.error })
    const body = read.body
    const added = await deps.addInboxItems(body)
    return added.ok ? json(200, added) : json(added.status, { ok: false, error: added.error })
  }
  const item = /^\/v1\/inbox\/([^/]{1,200})$/.exec(url.pathname)
  if (item) {
    if (req.method !== 'PATCH') return json(405, { ok: false, error: 'use PATCH' })
    if (!deps.plan) return json(404, { ok: false, error: 'the inbox is not available' })
    const read = readBody(req, caller)
    if (!read.ok) return json(read.status, { ok: false, error: read.error })
    const body = read.body
    let id: string
    try {
      id = decodeURIComponent(item[1]!)
    } catch {
      return json(400, { ok: false, error: 'bad item id' })
    }
    return fromReply(await deps.plan.updateItem(id, body, url.searchParams))
  }
  const milestone = url.pathname === '/v1/milestones' ? null : /^\/v1\/milestones\/([^/]{1,200})$/.exec(url.pathname)
  if ((url.pathname === '/v1/milestones' && req.method === 'POST') || milestone) {
    if (!deps.plan) return json(404, { ok: false, error: 'Plan is not available' })
    const method = req.method
    if (milestone ? method !== 'PATCH' && method !== 'DELETE' : method !== 'POST') return json(405, { ok: false, error: milestone ? 'use PATCH or DELETE' : 'use GET or POST' })
    const read = readBody(req, caller)
    if (!read.ok) return json(read.status, { ok: false, error: read.error })
    const body = read.body
    let id: string | null = null
    if (milestone) {
      try {
        id = decodeURIComponent(milestone[1]!)
      } catch {
        return json(400, { ok: false, error: 'bad milestone id' })
      }
    }
    return fromReply(await deps.plan.changeMilestone(id, method as 'POST' | 'PATCH' | 'DELETE', body, url.searchParams))
  }
  if (url.pathname === '/v1/automations' || url.pathname.startsWith('/v1/automations/')) {
    if (!deps.automations) return json(404, { ok: false, error: 'automations are not available' })
    const one = /^\/v1\/automations\/([^/]{1,200})$/.exec(url.pathname)
    if (!one && url.pathname !== '/v1/automations') return json(404, { ok: false, error: 'unknown endpoint' })
    if (!one && req.method === 'GET') return fromReply(await deps.automations.list(url.searchParams))
    if (one ? req.method !== 'PATCH' : req.method !== 'POST') return json(405, { ok: false, error: one ? 'use PATCH' : 'use GET or POST' })
    const read = readBody(req, caller)
    if (!read.ok) return json(read.status, { ok: false, error: read.error })
    const body = read.body
    if (!one) return fromReply(await deps.automations.create(body, url.searchParams))
    let id: string
    try {
      id = decodeURIComponent(one[1]!)
    } catch {
      return json(400, { ok: false, error: 'bad automation id' })
    }
    return fromReply(await deps.automations.update(id, body, url.searchParams))
  }
  if (url.pathname === '/v1/history' || url.pathname.startsWith('/v1/history/')) {
    if (!deps.automations) return json(404, { ok: false, error: 'the history is not available' })
    if (req.method !== 'GET') return json(405, { ok: false, error: 'use GET' })
    if (url.pathname === '/v1/history') return fromReply(await deps.automations.history(url.searchParams))
    const past = /^\/v1\/history\/([^/]{1,100})\/([^/]{1,200})$/.exec(url.pathname)
    if (!past) return json(404, { ok: false, error: 'unknown endpoint' })
    let ids: [string, string]
    try {
      ids = [decodeURIComponent(past[1]!), decodeURIComponent(past[2]!)]
    } catch {
      return json(400, { ok: false, error: 'bad agent or session id' })
    }
    return fromReply(await deps.automations.session(ids[0], ids[1], url.searchParams))
  }
  if (url.pathname.startsWith('/v1/analytics/')) {
    if (!deps.analytics) return json(404, { ok: false, error: 'analytics are not available' })
    if (url.pathname === '/v1/analytics/query') {
      if (req.method !== 'POST') return json(405, { ok: false, error: 'use POST' })
      const read = readBody(req, caller)
      if (!read.ok) return json(read.status, { ok: false, error: read.error })
      const body = read.body
      return fromReply(await deps.analytics.query(body, url.searchParams))
    }
    const route = url.pathname === '/v1/analytics/schema' ? 'schema' : url.pathname === '/v1/analytics/report' ? 'report' : null
    if (!route) return json(404, { ok: false, error: 'unknown endpoint' })
    if (req.method !== 'GET') return json(405, { ok: false, error: 'use GET' })
    return fromReply(await deps.analytics[route](url.searchParams))
  }
  const message = /^\/v1\/sessions\/([^/]{1,200})\/message$/.exec(url.pathname)
  if (url.pathname === '/v1/sessions' || url.pathname === '/v1/notify' || message) {
    if (!deps.sessions) return json(404, { ok: false, error: 'sessions are not available' })
    // Only a session, proven by its token, sees or reaches the others (authorizeControl refuses the rest).
    if (!caller) return json(401, { ok: false, error: 'this needs the session token: send X-Workhub-Token: $WORKHUB_SESSION_TOKEN' })
    if (url.pathname === '/v1/sessions' && req.method === 'GET') return fromReply(await deps.sessions.list(caller.session))
    if (req.method !== 'POST') return json(405, { ok: false, error: url.pathname === '/v1/sessions' ? 'use GET or POST' : 'use POST' })
    const sent = readBody(req, caller)
    if (!sent.ok) return json(sent.status, { ok: false, error: sent.error })
    if (url.pathname === '/v1/notify') return fromReply(await deps.sessions.notify(caller.session, sent.body))
    if (!message) return fromReply(await deps.sessions.propose(caller.session, sent.body))
    let target: string
    try {
      target = decodeURIComponent(message[1]!)
    } catch {
      return json(400, { ok: false, error: 'bad session id' })
    }
    return fromReply(await deps.sessions.message(caller.session, target, sent.body))
  }
  const read = Object.hasOwn(PLAN_READS, url.pathname) ? PLAN_READS[url.pathname] : undefined
  if (read) {
    if (req.method !== 'GET') return json(405, { ok: false, error: 'use GET' })
    if (!deps.plan) return json(404, { ok: false, error: 'Plan is not available' })
    return fromReply(await deps.plan[read](url.searchParams))
  }
  const review = /^\/v1\/sessions\/([\w-]{1,100})\/review$/.exec(url.pathname)
  if (!review) return json(404, { ok: false, error: 'unknown endpoint' })
  if (req.method !== 'POST') return json(405, { ok: false, error: 'use POST' })
  const sent = readBody(req, caller)
  if (!sent.ok) return json(sent.status, { ok: false, error: sent.error })
  const repos = parseReviewBody(sent.body, isDir)
  if (typeof repos === 'string') return json(400, { ok: false, error: repos })
  const result = await deps.openReview(review[1]!, repos)
  if (!result.ok) return json(result.status, { ok: false, error: result.error })
  return json(200, { ok: true })
}

/** Handles one HTTP request through `serveControl`; exported for tests. */
export async function handleControl(deps: ControlDeps, req: IncomingMessage, res: ServerResponse, isDir: (path: string) => boolean = isDirectory): Promise<void> {
  const read = await readText(req)
  const request: ControlRequest = { method: req.method ?? 'GET', url: req.url ?? '/', headers: req.headers, ...('body' in read ? { body: read.body } : { bodyTooLarge: true }) }
  send(res, await serveControl(deps, request, isDir))
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
    handleControl(deps, req, res).catch((e: unknown) => failed(deps, res, e))
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
    if (req.headers.origin !== undefined || !hasControlToken(req, token)) return send(res, json(401, { ok: false, error: 'missing or wrong token: send Authorization: Bearer $WORKHUB_TOKEN' }))
    handleControl(deps, req, res).catch((e: unknown) => failed(deps, res, e))
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
