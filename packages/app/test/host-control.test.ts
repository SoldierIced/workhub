import { describe, expect, it, vi } from 'vitest'
import { CONTROL_REQUEST_EVENT, CONTROL_RESPOND_METHOD, HostRequestError } from '@workhub/adapters/host'
import { workhubMcpLaunch } from '../src/main/agent-tools'
import { answerRelayedControl, mcpLaunchTarget, sessionEndpoint, type ControlServe } from '../src/main/host-control'
import { serveControl } from '../src/main/control-server'

/** A client that records what is answered and lets the test fire relayed requests. */
function fakeClient(respond: (params: unknown) => Promise<unknown> = async () => ({ delivered: true })) {
  const handlers = new Map<string, (p: unknown) => void>()
  const sent: { method: string; params: unknown }[] = []
  const client = {
    onEvent: (name: string, h: (p: unknown) => void) => (handlers.set(name, h), () => handlers.delete(name)),
    request: vi.fn(async (method: string, params?: unknown) => {
      sent.push({ method, params })
      return respond(params)
    })
  }
  const fire = (p: unknown) => handlers.get(CONTROL_REQUEST_EVENT)!(p)
  return { client: client as never, sent, fire, handlers }
}

const relayed = (rid: number, url: string, token: string | null, body = '') => ({
  rid,
  method: url.endsWith('/review') ? 'POST' : 'GET',
  url,
  headers: token ? { 'x-workhub-token': token } : {},
  body
})

describe('answerRelayedControl', () => {
  it('serves relayed requests through main and authorizes them by the session token', async () => {
    const opened: string[] = []
    const deps = { auth: { sessionOf: (t: string) => (t === 't-s1' ? 's1' : undefined), readOnly: () => false }, openReview: (id: string) => (opened.push(id), { ok: true as const }) }
    const serve: ControlServe = (req) => serveControl(deps, req, () => true)
    const { client, sent, fire } = fakeClient()
    answerRelayedControl(client, () => serve, () => {})

    fire(relayed(1, '/v1/sessions/s1/review', 't-s1', '{}'))
    fire(relayed(2, '/v1/sessions/s1/review', null, '{}'))
    fire(relayed(3, '/v1/sessions/s2/review', 't-s1', '{}'))
    await vi.waitFor(() => expect(sent).toHaveLength(3))
    const byRid = Object.fromEntries(sent.map((s) => [(s.params as { rid: number }).rid, s]))
    expect(sent.every((s) => s.method === CONTROL_RESPOND_METHOD)).toBe(true)
    expect(byRid[1]!.params).toEqual({ rid: 1, status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' })
    expect(byRid[2]!.params).toMatchObject({ rid: 2, status: 401 })
    expect(byRid[3]!.params).toMatchObject({ rid: 3, status: 403 })
    expect(opened).toEqual(['s1'])
  })

  it('answers 503 while main has no endpoint and 500 when serving throws; drops malformed requests', async () => {
    const log = vi.fn()
    let serve: ControlServe | null = null
    const { client, sent, fire } = fakeClient()
    answerRelayedControl(client, () => serve, log)
    fire(relayed(1, '/v1/people', 't'))
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]!.params).toMatchObject({ rid: 1, status: 503 })

    serve = async () => {
      throw new Error('boom')
    }
    fire(relayed(2, '/v1/people', 't'))
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    expect(sent[1]!.params).toMatchObject({ rid: 2, status: 500, body: JSON.stringify({ ok: false, error: 'boom' }) })

    fire({ rid: 'x' })
    expect(log).toHaveBeenCalledWith('host: a malformed control request was dropped')
    expect(sent).toHaveLength(2)
  })

  it('answers 502 when the answer does not fit the channel', async () => {
    let first = true
    const { client, sent, fire } = fakeClient(async () => {
      if (first) {
        first = false
        throw new HostRequestError('too_large', 'host message too large')
      }
      return { delivered: true }
    })
    answerRelayedControl(client, () => async () => ({ status: 200, headers: {}, body: 'x'.repeat(10) }), () => {})
    fire(relayed(7, '/v1/history', 't'))
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    expect(sent[1]!.params).toMatchObject({ rid: 7, status: 502 })
  })
})

describe('endpoint and MCP server per host', () => {
  const remote = { socket: '/run/user/1000/workhub/host-42.sock', node: '/users/ana/.workhub/host/2.0.0/node/bin/node', mcpScript: '/users/ana/.workhub/host/2.0.0/bridge/workhub-mcp.mjs' }
  const local = { node: 'C:\\Program Files\\Workhub\\Workhub.exe', script: 'C:\\Program Files\\Workhub\\bridge\\workhub-mcp.mjs' }
  const loopback = { url: 'http://127.0.0.1:5000', token: 't' }

  it("gives a local session main's endpoint and a host session the host's socket", () => {
    expect(sessionEndpoint(undefined, loopback, true)).toBe(loopback)
    expect(sessionEndpoint(undefined, null, true)).toBeNull()
    expect(sessionEndpoint(remote, loopback, true)).toEqual({ socket: remote.socket })
    // Nothing serves what the host relays yet, or the host has no socket: no endpoint.
    expect(sessionEndpoint(remote, loopback, false)).toBeNull()
    expect(sessionEndpoint(null, loopback, true)).toBeNull()
  })

  it("runs Workhub's MCP server with the host's Node and bridge for a host session", () => {
    const env = { WORKHUB_SESSION: 's1', WORKHUB_SESSION_TOKEN: 'st', WORKHUB_SOCKET: remote.socket, WORKHUB_URL: '', WORKHUB_TOKEN: '' }
    expect(workhubMcpLaunch(env, mcpLaunchTarget(remote, local))).toEqual([
      { name: 'workhub', command: remote.node, args: [remote.mcpScript], env: { ELECTRON_RUN_AS_NODE: '1', WORKHUB_SESSION: 's1', WORKHUB_SESSION_TOKEN: 'st', WORKHUB_SOCKET: remote.socket } }
    ])
    const localEnv = { WORKHUB_SESSION: 's1', WORKHUB_SESSION_TOKEN: 'st', WORKHUB_SOCKET: '', WORKHUB_URL: loopback.url, WORKHUB_TOKEN: 't' }
    expect(workhubMcpLaunch(localEnv, mcpLaunchTarget(undefined, local))[0]).toMatchObject({ command: local.node, args: [local.script] })
    expect(mcpLaunchTarget(null, local)).toBe(local)
  })
})
