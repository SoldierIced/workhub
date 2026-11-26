import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { confirmedWorktreeOf } from '@workhub/adapters/token-spend'
import { afterEach, describe, expect, it } from 'vitest'
import type { ControlAuth } from '../src/main/control-auth'
import { controlEnv, controlSocketPath, NO_CONTROL_ENV, linkedMainOf, newControlToken, parseReviewBody, privateSocketDir, probeSocket, reviewPathOutside, serveControl, startControlServer, startLoopbackControlServer, usesLoopbackControl, type ReviewRequestRepo } from '../src/main/control-server'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** Sessions by token, for the endpoint's `auth`: `t-<id>` is the token of session `<id>`. */
function testAuth(sessions: readonly string[] = ['s1'], readOnly: readonly string[] = []): ControlAuth {
  return { sessionOf: (t) => sessions.find((s) => `t-${s}` === t), readOnly: (id) => readOnly.includes(id) }
}

function call(socketPath: string, method: string, path: string, body?: unknown, token: string | null = 't-s1'): Promise<{ status: number; json: { ok: boolean; error?: string } }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, method, path, headers: { 'content-type': 'application/json', ...(token ? { 'x-workhub-token': token } : {}) } }, (res) => {
      let text = ''
      res.on('data', (c) => (text += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) }))
    })
    req.on('error', reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}

describe('control endpoint', () => {
  it('puts the socket in the data folder, a temp file for long paths, a pipe on Windows', () => {
    expect(controlSocketPath('/data/wh', 'darwin')).toBe(join('/data/wh', 'control.sock'))
    // `join` follows the host's separator, so the expectation is built with it too (the suite also runs on Windows).
    const long = controlSocketPath(`/${'x'.repeat(120)}`, 'darwin', () => '/run/user/501/workhub')
    expect(long.startsWith(join('/run/user/501/workhub', 'workhub-control-'))).toBe(true)
    expect(long).toMatch(/workhub-control-[0-9a-f]{16}\.sock$/)
    expect(controlSocketPath('C:\\data', 'win32')).toMatch(/^\\\\\.\\pipe\\workhub-control-[0-9a-f]{16}$/)
    // Every variable is set, the unused ones empty, so nothing inherited from a parent process is left.
    expect(controlEnv('s1', { socket: '/x.sock' }, () => 'st')).toEqual({ WORKHUB_SESSION: 's1', WORKHUB_SESSION_TOKEN: 'st', WORKHUB_SOCKET: '/x.sock', WORKHUB_URL: '', WORKHUB_TOKEN: '' })
    expect(controlEnv('s1', { url: 'http://127.0.0.1:5000', token: 't' }, () => 'st')).toEqual({ WORKHUB_SESSION: 's1', WORKHUB_SESSION_TOKEN: 'st', WORKHUB_SOCKET: '', WORKHUB_URL: 'http://127.0.0.1:5000', WORKHUB_TOKEN: 't' })
    // No token is minted while no endpoint listens.
    expect(controlEnv('s1', null, () => expect.unreachable())).toEqual({ WORKHUB_SESSION: '', WORKHUB_SESSION_TOKEN: '', WORKHUB_SOCKET: '', WORKHUB_URL: '', WORKHUB_TOKEN: '' })
    expect(NO_CONTROL_ENV).toEqual(controlEnv('s1', null, () => ''))
    expect(usesLoopbackControl('win32')).toBe(true)
    expect(usesLoopbackControl('darwin')).toBe(false)
    expect(newControlToken()).toMatch(/^[0-9a-f]{64}$/)
    expect(newControlToken()).not.toBe(newControlToken())
  })

  it('serves on a loopback port only with the token and without a browser origin (Windows)', async () => {
    const token = newControlToken()
    const opened: string[] = []
    const started = await startLoopbackControlServer(token, { auth: testAuth(), openReview: (id) => (opened.push(id), { ok: true }) })
    expect(started).not.toBeNull()
    const { server, url } = started!
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    const port = Number(new URL(url).port)
    const hit = (headers: Record<string, string>, method = 'GET', path = '/v1/health') =>
      new Promise<number>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port, method, path, headers: { 'content-type': 'application/json', ...headers } }, (res) => {
          res.resume()
          res.on('end', () => resolve(res.statusCode ?? 0))
        })
        req.on('error', reject)
        req.end(method === 'POST' ? '{}' : undefined)
      })
    try {
      expect(await hit({})).toBe(401)
      expect(await hit({ authorization: 'Bearer nope' })).toBe(401)
      expect(await hit({ authorization: `Bearer ${token}`, origin: 'https://evil.example.com' })).toBe(401)
      expect(await hit({ authorization: `Bearer ${token}` })).toBe(200)
      // The launch token only reaches the endpoint: acting as a session needs that session's token on top.
      expect(await hit({ authorization: `Bearer ${token}` }, 'POST', '/v1/sessions/s1/review')).toBe(401)
      expect(await hit({ 'x-workhub-token': 't-s1' }, 'POST', '/v1/sessions/s1/review')).toBe(401)
      expect(await hit({ authorization: `Bearer ${token}`, 'x-workhub-token': 't-s1' }, 'POST', '/v1/sessions/s1/review')).toBe(200)
      expect(opened).toEqual(['s1'])
    } finally {
      server.close()
    }
  })

  it('answers a failure inside a route with a fixed message, and logs what failed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wh-ctl-'))
    dirs.push(dir)
    const logged: string[] = []
    const socket = controlSocketPath(dir)
    const server = await startControlServer(socket, {
      auth: testAuth(['s1']),
      log: (m) => void logged.push(m),
      openReview: () => {
        throw new Error('<img src=x onerror=alert(1)>')
      }
    })
    try {
      expect(await call(socket, 'POST', '/v1/sessions/s1/review', {})).toEqual({ status: 500, json: { ok: false, error: 'internal error' } })
      expect(logged.some((m) => m.includes('<img src=x onerror=alert(1)>'))).toBe(true)
    } finally {
      server?.close()
    }
  })

  it('checks the repos of a review request', async () => {
    const dir = (p: string) => p.startsWith('/ok')
    expect(await parseReviewBody(undefined, dir)).toEqual([])
    expect(await parseReviewBody({ repos: ['/ok/a', { path: '/ok/b', base: 'origin/main' }] }, dir)).toEqual([{ path: '/ok/a' }, { path: '/ok/b', base: 'origin/main' }])
    expect(await parseReviewBody({ repos: [{ path: 'rel' }] }, dir)).toMatch(/absolute/)
    expect(await parseReviewBody({ repos: ['/nope'] }, dir)).toMatch(/not a folder/)
    expect(await parseReviewBody({ repos: [{ path: '/ok/a', base: 'x; rm -rf' }] }, dir)).toMatch(/bad "base"/)
  })

  it('opens the review of a session over the socket', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wh-ctl-'))
    dirs.push(dir)
    const opened: [string, ReviewRequestRepo[]][] = []
    // A socket file next to the maps, or a named pipe on Windows.
    const socket = controlSocketPath(dir)
    const server = await startControlServer(socket, {
      auth: testAuth(['s1', 'zz']),
      openReview: (id, repos) => (id === 's1' ? (opened.push([id, repos]), { ok: true }) : { ok: false, status: 404, error: 'unknown session' })
    })
    expect(server).not.toBeNull()
    try {
      expect(await call(socket, 'GET', '/v1/health')).toEqual({ status: 200, json: { ok: true } })
      expect(await call(socket, 'POST', '/v1/sessions/s1/review', { repos: [dir] })).toEqual({ status: 200, json: { ok: true } })
      expect(opened).toEqual([['s1', [{ path: dir }]]])
      expect((await call(socket, 'POST', '/v1/sessions/zz/review', undefined, 't-zz')).status).toBe(404)
      expect((await call(socket, 'GET', '/v1/sessions/s1/review')).status).toBe(405)
      expect((await call(socket, 'POST', '/nope')).status).toBe(404)
    } finally {
      server?.close()
    }
  })
})

describe('serveControl (plain requests)', () => {
  const plain = (method: string, url: string, token: string | null, body?: unknown) => ({
    method,
    url,
    headers: token ? { 'x-workhub-token': token } : {},
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })

  it('answers like the HTTP endpoint: 200 with the token, 401 without, 403 for another session', async () => {
    const opened: string[] = []
    const deps = { auth: testAuth(['s1', 's2']), openReview: (id: string) => (opened.push(id), { ok: true as const }) }
    const ok = await serveControl(deps, plain('POST', '/v1/sessions/s1/review', 't-s1', {}), () => true)
    expect(ok).toEqual({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok: true }) })
    expect(opened).toEqual(['s1'])
    const anonymous = await serveControl(deps, plain('POST', '/v1/sessions/s1/review', null, {}))
    expect(anonymous.status).toBe(401)
    expect(JSON.parse(anonymous.body)).toMatchObject({ ok: false })
    expect((await serveControl(deps, plain('POST', '/v1/sessions/s2/review', 't-s1', {}))).status).toBe(403)
    expect((await serveControl(deps, plain('GET', '/v1/health', null))).status).toBe(200)
    expect(opened).toEqual(['s1'])
  })

  it("checks a review's repos on the session's host, not on this computer", async () => {
    const opened: unknown[] = []
    const asked: [string, string][] = []
    const deps = {
      auth: testAuth(['s1']),
      openReview: (_id: string, repos: unknown) => (opened.push(repos), { ok: true as const }),
      // The session runs in WSL: its folders are the distribution's.
      isReviewFolder: async (sessionId: string, path: string) => (asked.push([sessionId, path]), path === '/home/ana/acme')
    }
    const ok = await serveControl(deps, plain('POST', '/v1/sessions/s1/review', 't-s1', { repos: ['/home/ana/acme'] }), () => false)
    expect(ok.status).toBe(200)
    expect(opened).toEqual([[{ path: '/home/ana/acme' }]])
    expect(asked).toEqual([['s1', '/home/ana/acme']])
    const missing = await serveControl(deps, plain('POST', '/v1/sessions/s1/review', 't-s1', { repos: ['/home/ana/gone'] }), () => true)
    expect(missing.status).toBe(400)
  })

  it('refuses a body that is not JSON or passed the cap', async () => {
    const deps = { auth: testAuth(), openReview: () => ({ ok: true as const }) }
    const bad = await serveControl(deps, { method: 'POST', url: '/v1/sessions/s1/review', headers: { 'x-workhub-token': 't-s1' }, body: '<script>nope' })
    expect(bad.status).toBe(400)
    // The parser's message quotes the body: it is not sent back.
    expect(JSON.parse(bad.body)).toEqual({ ok: false, error: 'the body is not valid JSON' })
    const big = await serveControl(deps, { method: 'POST', url: '/v1/sessions/s1/review', headers: { 'x-workhub-token': 't-s1' }, bodyTooLarge: true })
    expect(big.status).toBe(400)
    expect(JSON.parse(big.body)).toEqual({ ok: false, error: 'body too large' })
  })
})

describe('automation and history routes', () => {
  it('routes each call to its handler with the decoded ids and refuses other methods', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wh-ctl-'))
    dirs.push(dir)
    const calls: string[] = []
    const ok = (what: string) => async (...args: unknown[]) => (calls.push([what, ...args.filter((a) => typeof a === 'string')].join(' ')), { status: 200, body: { ok: true } })
    const socket = controlSocketPath(dir)
    const server = await startControlServer(socket, {
      auth: testAuth(),
      openReview: () => ({ ok: true }),
      automations: { list: ok('list'), create: ok('create'), update: ok('update'), history: ok('history'), session: ok('session') }
    })
    try {
      expect((await call(socket, 'GET', '/v1/automations')).status).toBe(200)
      expect((await call(socket, 'POST', '/v1/automations', { automation: { name: 'x' } })).status).toBe(200)
      expect((await call(socket, 'PATCH', '/v1/automations/a%201', { automation: {} })).status).toBe(200)
      expect((await call(socket, 'GET', '/v1/history')).status).toBe(200)
      expect((await call(socket, 'GET', '/v1/history/claude/s-1')).status).toBe(200)
      expect(calls).toEqual(['list', 'create', 'update a 1', 'history', 'session claude s-1'])
      expect((await call(socket, 'DELETE', '/v1/automations/a1')).status).toBe(405)
      expect((await call(socket, 'PUT', '/v1/automations')).status).toBe(405)
      expect((await call(socket, 'POST', '/v1/history')).status).toBe(405)
      expect((await call(socket, 'GET', '/v1/history/claude')).status).toBe(404)
      expect((await call(socket, 'GET', '/v1/automations/a/b')).status).toBe(404)
    } finally {
      server?.close()
    }
  })
})

describe.skipIf(process.platform === 'win32')('control socket ownership', () => {
  // Under /tmp: the user's temp folder on macOS is too long for some socket paths.
  const newDir = () => {
    const dir = mkdtempSync(join('/tmp', 'wh-own-'))
    dirs.push(dir)
    return dir
  }

  it('puts a long-path socket in a folder only the user can open', () => {
    const runtime = newDir()
    const dir = privateSocketDir({ XDG_RUNTIME_DIR: runtime })
    expect(dir).toBe(join(runtime, 'workhub'))
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    const tmp = newDir()
    const made = privateSocketDir({}, tmp)
    dirs.push(made)
    expect(made.startsWith(join(tmp, 'workhub-'))).toBe(true)
    expect(statSync(made).mode & 0o777).toBe(0o700)
    // Two launches never share a predictable path.
    const other = privateSocketDir({}, tmp)
    dirs.push(other)
    expect(other).not.toBe(made)
    const socket = controlSocketPath(`/${'x'.repeat(120)}`, 'linux', () => made)
    expect(Buffer.byteLength(socket)).toBeLessThanOrEqual(100)
  })

  it('leaves a socket another app serves alone and answers null', async () => {
    const socket = join(newDir(), 'control.sock')
    const logs: string[] = []
    const first = await startControlServer(socket, { auth: testAuth(), openReview: () => ({ ok: true }) })
    expect(first).not.toBeNull()
    try {
      expect(await probeSocket(socket)).toBe('live')
      const second = await startControlServer(socket, { auth: testAuth(), openReview: () => ({ ok: true }), log: (m) => logs.push(m) })
      expect(second).toBeNull()
      expect(logs.join()).toMatch(/served by another process/)
      // The first app still answers on its socket.
      expect(await call(socket, 'GET', '/v1/health')).toEqual({ status: 200, json: { ok: true } })
    } finally {
      first?.close()
    }
  })

  it('replaces a socket left by a process that died', async () => {
    const socket = join(newDir(), 'control.sock')
    expect(await probeSocket(socket)).toBe('stale')
    // A process that listens and is killed leaves its socket file behind.
    const child = spawn(process.execPath, ['-e', `require('node:net').createServer().listen(${JSON.stringify(socket)}, () => console.log('up'))`], { stdio: ['ignore', 'pipe', 'inherit'] })
    await new Promise<void>((resolve) => child.stdout!.once('data', () => resolve()))
    child.kill('SIGKILL')
    await new Promise((resolve) => child.once('exit', resolve))
    expect(existsSync(socket)).toBe(true)
    expect(await probeSocket(socket)).toBe('stale')
    const server = await startControlServer(socket, { auth: testAuth(), openReview: () => ({ ok: true }) })
    expect(server).not.toBeNull()
    try {
      expect(await call(socket, 'GET', '/v1/health')).toEqual({ status: 200, json: { ok: true } })
    } finally {
      server?.close()
    }
  })
})

describe('reviewPathOutside on a host', () => {
  it("compares the host's real paths as POSIX paths, whatever this computer is", async () => {
    // The distribution's realpath: /home/ana/link points outside the session's folders.
    const real = async (p: string) => ({ '/home/ana/acme': '/home/ana/acme', '/home/ana/acme/api': '/home/ana/acme/api', '/home/ana/link': '/srv/other', '/home/ana/work': '/home/ana/work' })[p] ?? null
    const roots = ['/home/ana/acme', '/home/ana/work']
    expect(await reviewPathOutside([{ path: '/home/ana/acme/api' }, { path: '/home/ana/acme' }], roots, real)).toBeNull()
    expect(await reviewPathOutside([{ path: '/home/ana/link' }], roots, real)).toBe('/home/ana/link')
    expect(await reviewPathOutside([{ path: '/home/ana/missing' }], roots, real)).toBe('/home/ana/missing')
  })
})

describe('reviewPathOutside with linked worktrees', () => {
  it("accepts a folder outside the roots only when mainOf names a repository inside them", async () => {
    const real = async (p: string) => p
    const roots = ['/home/ana/acme']
    const mainOf = async (p: string) => ({ '/tmp/api-fix': '/home/ana/acme/api', '/tmp/other-fix': '/srv/other' })[p] ?? null
    expect(await reviewPathOutside([{ path: '/tmp/api-fix' }], roots, real, mainOf)).toBeNull()
    expect(await reviewPathOutside([{ path: '/tmp/other-fix' }], roots, real, mainOf)).toBe('/tmp/other-fix')
    expect(await reviewPathOutside([{ path: '/tmp/plain' }], roots, real, mainOf)).toBe('/tmp/plain')
    // Without mainOf (a WSL session, the folder check of a proposal) nothing changes.
    expect(await reviewPathOutside([{ path: '/tmp/api-fix' }], roots, real)).toBe('/tmp/api-fix')
  })
})

describe('linkedMainOf', () => {
  const real = async (p: string) => ({ '/home/ana': '/var/home/ana' })[p] ?? p
  const links: Record<string, { worktree: string; main: string }> = {
    '/tmp/api-fix': { worktree: '/tmp/api-fix', main: '/var/home/ana/acme/api' },
    '/var/home/ana': { worktree: '/var/home/ana', main: '/var/home/ana/acme/api' },
    '/tmp/dots': { worktree: '/tmp/dots', main: '/var/home/ana' }
  }
  const confirm = async (p: string) => links[p] ?? null
  it("names a worktree's repository, never for a worktree or repository at or above the real home", async () => {
    expect(await linkedMainOf('/tmp/api-fix', '/home/ana', confirm, real)).toBe('/var/home/ana/acme/api')
    expect(await linkedMainOf('/var/home/ana', '/home/ana', confirm, real)).toBeNull()
    expect(await linkedMainOf('/tmp/dots', '/home/ana', confirm, real)).toBeNull()
    expect(await linkedMainOf('/tmp/plain', '/home/ana', confirm, real)).toBeNull()
  })
})

describe.skipIf(process.platform === 'win32')('linkedMainOf with git', () => {
  it('reads worktrees made by git, with absolute and relative links', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'wh-lwt-')))
    dirs.push(base)
    const main = join(base, 'profile', 'api')
    mkdirSync(main, { recursive: true })
    const git = (...args: string[]) => execFileSync('git', args, { cwd: main, stdio: 'ignore' })
    git('init', '-q')
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init')
    git('worktree', 'add', '-q', join(base, 'out', 'abs'))
    git('-c', 'worktree.useRelativePaths=true', 'worktree', 'add', '-q', join(base, 'out', 'rel'))
    const home = join(base, 'home')
    mkdirSync(home)
    expect(await linkedMainOf(join(base, 'out', 'abs'), home, confirmedWorktreeOf)).toBe(main)
    expect(await linkedMainOf(join(base, 'out', 'rel'), home, confirmedWorktreeOf)).toBe(main)
    expect(await linkedMainOf(main, home, confirmedWorktreeOf)).toBeNull()
  })
})

describe.skipIf(process.platform === 'win32')('reviewPathOutside', () => {
  it('accepts folders inside a root, refuses outside ones and symlinks that point outside', async () => {
    const base = mkdtempSync(join(tmpdir(), 'wh-rev-'))
    dirs.push(base)
    const session = join(base, 'session')
    const profile = join(base, 'profile')
    const outside = join(base, 'outside')
    for (const d of [join(session, 'repo'), profile, outside]) mkdirSync(d, { recursive: true })
    symlinkSync(outside, join(session, 'link'))
    const roots = [session, profile]
    expect(await reviewPathOutside([{ path: join(session, 'repo') }, { path: session }, { path: profile }], roots)).toBeNull()
    expect(await reviewPathOutside([{ path: join(session, 'repo') }, { path: outside }], roots)).toBe(outside)
    expect(await reviewPathOutside([{ path: join(session, 'link') }], roots)).toBe(join(session, 'link'))
    expect(await reviewPathOutside([{ path: join(session, '..', 'outside') }], roots)).toBe(join(session, '..', 'outside'))
    expect(await reviewPathOutside([{ path: join(session, 'missing') }], roots)).toBe(join(session, 'missing'))
  })
})
