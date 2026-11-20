import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { HOST_PROTOCOL_VERSION, type HostHello } from '@workhub/core'
import { HostChannel, HostClient, HostHandlerError, HostServer, type HostClientNotice, type HostHandlers } from '../src/host'

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

const hello: Omit<HostHello, 't'> = {
  protocol: HOST_PROTOCOL_VERSION,
  hostVersion: '2.0.0-test',
  features: ['git'],
  platform: 'linux',
  home: '/home/ana',
  pathFlavor: 'posix'
}
const expected = { protocol: HOST_PROTOCOL_VERSION, hostVersion: '2.0.0-test' }

function connect(handlers: HostHandlers = {}, opts: { hello?: Omit<HostHello, 't'>; helloTimeoutMs?: number; silent?: boolean } = {}) {
  const toHost = new PassThrough()
  const toApp = new PassThrough()
  const notices: HostClientNotice[] = []
  const appChannel = new HostChannel(toApp, toHost)
  const hostChannel = new HostChannel(toHost, toApp)
  const client = new HostClient(appChannel, { expected, helloTimeoutMs: opts.helloTimeoutMs, onNotice: (n) => notices.push(n) })
  const server = opts.silent ? undefined : new HostServer(hostChannel, { hello: opts.hello ?? hello, handlers })
  return { client, server, appChannel, hostChannel, toApp, notices }
}

describe('HostClient and HostServer', () => {
  it('completes the hello handshake', async () => {
    const { client } = connect()
    await expect(client.ready).resolves.toEqual({ t: 'hello', ...hello })
    expect(client.hello?.home).toBe('/home/ana')
  })

  it('rejects a host with another protocol or build, and closes the channel', async () => {
    const protocol = connect({}, { hello: { ...hello, protocol: HOST_PROTOCOL_VERSION + 1 } })
    await expect(protocol.client.ready).rejects.toMatchObject({ reason: 'protocol_mismatch' })
    expect(protocol.appChannel.closed).toBe(true)
    const version = connect({}, { hello: { ...hello, hostVersion: '1.9.0' } })
    await expect(version.client.ready).rejects.toMatchObject({ reason: 'version_mismatch' })
    await expect(version.client.request('ping')).rejects.toMatchObject({ code: 'closed' })
  })

  it('gives up when the host never says hello', async () => {
    const { client, appChannel } = connect({}, { silent: true, helloTimeoutMs: 20 })
    await expect(client.ready).rejects.toMatchObject({ reason: 'timeout' })
    expect(appChannel.closed).toBe(true)
  })

  it('round-trips a request', async () => {
    const { client } = connect({ add: async (p) => (p as { a: number; b: number }).a + (p as { a: number; b: number }).b })
    await expect(client.request<number>('add', { a: 2, b: 3 })).resolves.toBe(5)
  })

  it('runs requests concurrently and matches responses that arrive out of order', async () => {
    const order: string[] = []
    const { client } = connect({
      wait: (p) =>
        new Promise((resolve) =>
          setTimeout(() => {
            order.push(String(p))
            resolve(p)
          }, p === 'slow' ? 30 : 1)
        )
    })
    const results = await Promise.all([client.request('wait', 'slow'), client.request('wait', 'fast')])
    expect(results).toEqual(['slow', 'fast'])
    expect(order).toEqual(['fast', 'slow'])
  })

  it('passes a typed handler error through with its code', async () => {
    const { client } = connect({
      read: async () => {
        throw new HostHandlerError('bad_params', 'path is required')
      }
    })
    const err = await client.request('read', {}).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).toMatchObject({ code: 'bad_params', message: 'path is required' })
  })

  it('answers unknown_method for a method it does not have, inherited names included', async () => {
    const { client } = connect({})
    await expect(client.request('nope')).rejects.toMatchObject({ code: 'unknown_method' })
    await expect(client.request('toString')).rejects.toMatchObject({ code: 'unknown_method' })
  })

  it('turns a thrown error into internal, with the message and no stack', async () => {
    const { client } = connect({
      boom: () => {
        throw new Error('disk on fire')
      }
    })
    const err = (await client.request('boom').catch((e: unknown) => e)) as Error & { code: string }
    expect(err.code).toBe('internal')
    expect(err.message).toBe('disk on fire')
    expect(err.message).not.toContain('at ')
  })

  it('times a request out with code timeout', async () => {
    const { client } = connect({ hang: () => new Promise(() => {}) })
    await expect(client.request('hang', undefined, { timeoutMs: 20 })).rejects.toMatchObject({ code: 'timeout' })
  })

  it('stops waiting when the caller aborts', async () => {
    const { client } = connect({ hang: () => new Promise(() => {}) })
    const controller = new AbortController()
    const pending = client.request('hang', undefined, { signal: controller.signal })
    await client.ready
    controller.abort(new Error('user cancelled'))
    await expect(pending).rejects.toThrow('user cancelled')
  })

  it('delivers events to subscribers until they unsubscribe', async () => {
    const { client, server } = connect()
    await client.ready
    const got: unknown[] = []
    const off = client.onEvent('output', (p) => got.push(p))
    client.onEvent('other', () => got.push('wrong'))
    server!.emit('output', { chunk: 'a' })
    await tick()
    off()
    server!.emit('output', { chunk: 'b' })
    await tick()
    expect(got).toEqual([{ chunk: 'a' }])
  })

  it('rejects pending requests with closed when the host goes away, and later ones at once', async () => {
    const { client, hostChannel } = connect({ hang: () => new Promise(() => {}) })
    const pending = client.request('hang')
    await client.ready
    await tick()
    hostChannel.close()
    await expect(pending).rejects.toMatchObject({ code: 'closed' })
    await expect(client.request('hang')).rejects.toMatchObject({ code: 'closed' })
  })

  it('tells close subscribers once, with the reason, and late subscribers at once', async () => {
    const { client, hostChannel } = connect()
    await client.ready
    const reasons: string[] = []
    client.onClose((r) => reasons.push(r))
    const off = client.onClose(() => reasons.push('unsubscribed'))
    off()
    hostChannel.close()
    await tick()
    hostChannel.close()
    client.onClose((r) => reasons.push(`late: ${r}`))
    await tick()
    expect(reasons).toEqual(['the host channel closed', 'late: the host channel closed'])
  })

  it('aborts in-flight handlers and drops their late answers when the channel closes', async () => {
    let seen: AbortSignal | undefined
    const { client, hostChannel } = connect({
      slow: (_p, ctx) => {
        seen = ctx.signal
        return new Promise((resolve) => setTimeout(() => resolve('late'), 10))
      }
    })
    void client.request('slow').catch(() => {})
    await client.ready
    await tick()
    hostChannel.close()
    expect(seen?.aborted).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 20))
  })

  it('ignores a response for an id it never sent, and reports it', async () => {
    const { client, toApp, notices } = connect({ echo: async (p) => p })
    await client.ready
    toApp.write(JSON.stringify({ t: 'res', id: 999, r: 'stray' }) + '\n')
    await expect(client.request('echo', 'still works')).resolves.toBe('still works')
    expect(client.closed).toBe(false)
    expect(notices).toEqual([{ kind: 'unknown_response', id: 999 }])
  })
})
