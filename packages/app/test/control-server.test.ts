import { mkdtempSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { controlEnv, controlSocketPath, newControlToken, parseReviewBody, startControlServer, startLoopbackControlServer, usesLoopbackControl, type ReviewRequestRepo } from '../src/main/control-server'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function call(socketPath: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: { ok: boolean; error?: string } }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, method, path, headers: { 'content-type': 'application/json' } }, (res) => {
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
    expect(controlSocketPath(`/${'x'.repeat(120)}`, 'darwin')).toMatch(/workhub-control-[0-9a-f]{16}\.sock$/)
    expect(controlSocketPath('C:\\data', 'win32')).toMatch(/^\\\\\.\\pipe\\workhub-control-[0-9a-f]{16}$/)
    expect(controlEnv('s1', { socket: '/x.sock' })).toEqual({ WORKHUB_SESSION: 's1', WORKHUB_SOCKET: '/x.sock' })
    expect(controlEnv('s1', { url: 'http://127.0.0.1:5000', token: 't' })).toEqual({ WORKHUB_SESSION: 's1', WORKHUB_URL: 'http://127.0.0.1:5000', WORKHUB_TOKEN: 't' })
    expect(controlEnv('s1', null)).toEqual({ WORKHUB_SESSION: 's1' })
    expect(usesLoopbackControl('win32')).toBe(true)
    expect(usesLoopbackControl('darwin')).toBe(false)
    expect(newControlToken()).toMatch(/^[0-9a-f]{64}$/)
    expect(newControlToken()).not.toBe(newControlToken())
  })

  it('serves on a loopback port only with the token and without a browser origin (Windows)', async () => {
    const token = newControlToken()
    const opened: string[] = []
    const started = await startLoopbackControlServer(token, { openReview: (id) => (opened.push(id), { ok: true }) })
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
      expect(await hit({ authorization: `Bearer ${token}` }, 'POST', '/v1/sessions/s1/review')).toBe(200)
      expect(opened).toEqual(['s1'])
    } finally {
      server.close()
    }
  })

  it('checks the repos of a review request', () => {
    const dir = (p: string) => p.startsWith('/ok')
    expect(parseReviewBody(undefined, dir)).toEqual([])
    expect(parseReviewBody({ repos: ['/ok/a', { path: '/ok/b', base: 'origin/main' }] }, dir)).toEqual([{ path: '/ok/a' }, { path: '/ok/b', base: 'origin/main' }])
    expect(parseReviewBody({ repos: [{ path: 'rel' }] }, dir)).toMatch(/absolute/)
    expect(parseReviewBody({ repos: ['/nope'] }, dir)).toMatch(/not a folder/)
    expect(parseReviewBody({ repos: [{ path: '/ok/a', base: 'x; rm -rf' }] }, dir)).toMatch(/bad "base"/)
  })

  it('opens the review of a session over the socket', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wh-ctl-'))
    dirs.push(dir)
    const opened: [string, ReviewRequestRepo[]][] = []
    // A socket file next to the maps, or a named pipe on Windows.
    const socket = controlSocketPath(dir)
    const server = await startControlServer(socket, {
      openReview: (id, repos) => (id === 's1' ? (opened.push([id, repos]), { ok: true }) : { ok: false, status: 404, error: 'unknown session' })
    })
    expect(server).not.toBeNull()
    try {
      expect(await call(socket, 'GET', '/v1/health')).toEqual({ status: 200, json: { ok: true } })
      expect(await call(socket, 'POST', '/v1/sessions/s1/review', { repos: [dir] })).toEqual({ status: 200, json: { ok: true } })
      expect(opened).toEqual([['s1', [{ path: dir }]]])
      expect((await call(socket, 'POST', '/v1/sessions/zz/review')).status).toBe(404)
      expect((await call(socket, 'GET', '/v1/sessions/s1/review')).status).toBe(405)
      expect((await call(socket, 'POST', '/nope')).status).toBe(404)
    } finally {
      server?.close()
    }
  })
})
