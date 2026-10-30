/**
 * The local control endpoint: lets tools an agent runs inside a Workhub session ask Workhub for
 * something, today only "open the human review of my changes". It is HTTP over a Unix socket in
 * the data folder (a named pipe on Windows), so only the user's own processes reach it; every
 * session gets `WORKHUB_SESSION` (its id) and `WORKHUB_SOCKET` (the path) in its environment.
 *
 *   curl --unix-socket "$WORKHUB_SOCKET" -X POST "http://workhub/v1/sessions/$WORKHUB_SESSION/review" \
 *     -H 'content-type: application/json' -d '{"repos":[{"path":"/abs/repo","base":"origin/main"}]}'
 *
 * It also takes a flow map (the Flow maps screen), validated and stored in the data folder:
 *
 *   curl --unix-socket "$WORKHUB_SOCKET" -X POST http://workhub/v1/flow-maps \
 *     -H 'content-type: application/json' --data-binary @checkout.flow-map.json
 */
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, statSync, unlinkSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

const MAX_BODY = 256 * 1024
const MAX_REPOS = 20

export interface ReviewRequestRepo {
  path: string
  base?: string
}

export type ControlResult = { ok: true } | { ok: false; status: number; error: string }

export interface ControlDeps {
  /** Opens the session's "Review changes" window on these repos (plus the ones it finds itself). */
  openReview(sessionId: string, repos: ReviewRequestRepo[]): ControlResult
  /** Validates and stores a flow map (the Flow maps screen); errors name the fields. */
  saveFlowMap?(map: unknown): { ok: true; file: string; id: string } | { ok: false; errors: string[] }
  log?: (message: string) => void
}

/** Where the endpoint listens for a data folder: a socket file in it, or a named pipe on Windows. */
export function controlSocketPath(dataDir: string, platform: NodeJS.Platform = process.platform): string {
  const hash = createHash('sha256').update(dataDir).digest('hex').slice(0, 16)
  if (platform === 'win32') return `\\\\.\\pipe\\workhub-control-${hash}`
  const inData = join(dataDir, 'control.sock')
  // Unix socket paths are cut at about 104 bytes: a long data folder falls back to the user's temp folder.
  return Buffer.byteLength(inData) <= 100 ? inData : join(tmpdir(), `workhub-control-${hash}.sock`)
}

/** The environment a session gets to reach the endpoint. */
export function controlEnv(sessionId: string, socketPath: string): Record<string, string> {
  return { WORKHUB_SESSION: sessionId, WORKHUB_SOCKET: socketPath }
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

/** Starts the endpoint; a stale socket left by a crash is replaced. Resolves to null when it cannot listen. */
export function startControlServer(socketPath: string, deps: ControlDeps): Promise<Server | null> {
  if (process.platform !== 'win32' && existsSync(socketPath)) {
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
