// App side of the host protocol: waits for the host's hello, then sends requests and receives events.
import { HOST_REQUEST_TIMEOUT_MS, isCompatibleHello, type HelloMismatch, type HostErrorCode, type HostHello, type HostMessage } from '@workhub/core'
import type { HostChannel } from './channel'

/** How long the app waits for the first line from a host it just started. */
export const HOST_HELLO_TIMEOUT_MS = 15_000

/** A request that failed: the host's error response, or `timeout`/`closed` on this side. */
export class HostRequestError extends Error {
  constructor(
    readonly code: HostErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'HostRequestError'
  }
}

export type HostHelloFailure = HelloMismatch | 'timeout' | 'closed'

/** The handshake failed: the host is incompatible, silent, or went away first. */
export class HostHelloError extends Error {
  constructor(
    readonly reason: HostHelloFailure,
    message: string
  ) {
    super(message)
    this.name = 'HostHelloError'
  }
}

export type HostClientNotice =
  | { kind: 'unknown_response'; id: number }
  | { kind: 'unexpected_message'; t: HostMessage['t'] }

export interface HostClientOptions {
  /** The protocol and host build this app ships with; anything else is refused. */
  expected: { protocol: number; hostVersion: string }
  helloTimeoutMs?: number
  /** Messages that were valid lines but made no sense here. Reported, never fatal. */
  onNotice?: (notice: HostClientNotice) => void
}

export interface HostRequestOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (err: unknown) => void
  cleanup: () => void
}

export class HostClient {
  /** Resolves with the host's hello once it is accepted; the channel is closed when it is not. */
  readonly ready: Promise<HostHello>
  private acceptedHello: HostHello | undefined
  private nextId = 1
  private isClosed = false
  private readonly pending = new Map<number, Pending>()
  private readonly eventHandlers = new Map<string, Set<(payload: unknown) => void>>()
  private readonly closeHandlers = new Set<(reason: string) => void>()
  private closeReason = ''
  private settleHello!: { resolve: (hello: HostHello) => void; reject: (err: HostHelloError) => void }

  constructor(
    private readonly channel: HostChannel,
    private readonly options: HostClientOptions
  ) {
    this.ready = new Promise<HostHello>((resolve, reject) => (this.settleHello = { resolve, reject }))
    // Callers that only send requests learn about a failed handshake from those.
    this.ready.catch(() => {})
    const timer = setTimeout(() => {
      this.failHello(new HostHelloError('timeout', 'the host did not say hello in time'))
    }, options.helloTimeoutMs ?? HOST_HELLO_TIMEOUT_MS)
    void this.ready.then(
      () => clearTimeout(timer),
      () => clearTimeout(timer)
    )
    channel.onMessage((msg) => this.receive(msg))
    channel.onClose((err) => this.onChannelClosed(err))
  }

  /** The accepted hello, once the handshake is done. */
  get hello(): HostHello | undefined {
    return this.acceptedHello
  }

  get closed(): boolean {
    return this.isClosed
  }

  /** Sends a request once the handshake is done and resolves with its result. */
  async request<T = unknown>(method: string, params?: unknown, options: HostRequestOptions = {}): Promise<T> {
    if (this.isClosed) throw new HostRequestError('closed', 'the host channel is closed')
    options.signal?.throwIfAborted()
    try {
      await this.ready
    } catch (err) {
      throw new HostRequestError('closed', (err as Error).message)
    }
    options.signal?.throwIfAborted()
    if (this.isClosed) throw new HostRequestError('closed', 'the host channel is closed')
    const id = this.nextId++
    const timeoutMs = options.timeoutMs ?? HOST_REQUEST_TIMEOUT_MS
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => this.settle(id, new HostRequestError('timeout', `${method} timed out after ${timeoutMs} ms`)), timeoutMs)
      const onAbort = () => this.settle(id, options.signal?.reason ?? new Error('aborted'))
      options.signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        cleanup: () => {
          clearTimeout(timer)
          options.signal?.removeEventListener('abort', onAbort)
        }
      })
      try {
        this.channel.send({ t: 'req', id, m: method, ...(params === undefined ? {} : { p: params }) })
      } catch (err) {
        // Only an oversize message throws here.
        this.settle(id, new HostRequestError('too_large', (err as Error).message))
      }
    })
  }

  /** Subscribes to one event name; returns the unsubscribe function. */
  onEvent(name: string, handler: (payload: unknown) => void): () => void {
    let handlers = this.eventHandlers.get(name)
    if (!handlers) this.eventHandlers.set(name, (handlers = new Set()))
    handlers.add(handler)
    return () => {
      handlers.delete(handler)
      if (handlers.size === 0) this.eventHandlers.delete(name)
    }
  }

  /**
   * Called once when the channel closes (the host went away, or `close()`), after pending requests
   * were rejected; at once, on the next microtask, when it is already closed.
   */
  onClose(handler: (reason: string) => void): () => void {
    if (this.isClosed) {
      queueMicrotask(() => handler(this.closeReason))
      return () => {}
    }
    this.closeHandlers.add(handler)
    return () => this.closeHandlers.delete(handler)
  }

  close(): void {
    this.channel.close()
  }

  private receive(msg: HostMessage): void {
    if (msg.t === 'hello') {
      if (this.acceptedHello) return this.options.onNotice?.({ kind: 'unexpected_message', t: 'hello' })
      const check = isCompatibleHello(msg, this.options.expected)
      if (!check.ok) {
        const got = `protocol ${msg.protocol}, host ${msg.hostVersion}`
        const want = `protocol ${this.options.expected.protocol}, host ${this.options.expected.hostVersion}`
        return this.failHello(new HostHelloError(check.reason, `incompatible host (${got}; expected ${want})`))
      }
      this.acceptedHello = msg
      this.settleHello.resolve(msg)
      return
    }
    if (!this.acceptedHello || msg.t === 'req') return this.options.onNotice?.({ kind: 'unexpected_message', t: msg.t })
    if (msg.t === 'ev') {
      for (const handler of [...(this.eventHandlers.get(msg.ev) ?? [])]) handler(msg.p)
      return
    }
    if (!this.pending.has(msg.id)) return this.options.onNotice?.({ kind: 'unknown_response', id: msg.id })
    if ('e' in msg) this.settle(msg.id, new HostRequestError(msg.e.code, msg.e.message))
    else this.settle(msg.id, undefined, msg.r)
  }

  private settle(id: number, err: unknown, value?: unknown): void {
    const entry = this.pending.get(id)
    if (!entry) return
    this.pending.delete(id)
    entry.cleanup()
    if (err !== undefined) entry.reject(err)
    else entry.resolve(value)
  }

  private failHello(err: HostHelloError): void {
    if (this.acceptedHello) return
    this.settleHello.reject(err)
    this.channel.close()
  }

  private onChannelClosed(err?: Error): void {
    this.isClosed = true
    this.settleHello.reject(new HostHelloError('closed', err?.message ?? 'the host channel closed before hello'))
    const reason = err ? `the host channel closed: ${err.message}` : 'the host channel closed'
    for (const id of [...this.pending.keys()]) this.settle(id, new HostRequestError('closed', reason))
    this.closeReason = reason
    for (const handler of [...this.closeHandlers]) handler(reason)
    this.closeHandlers.clear()
  }
}
