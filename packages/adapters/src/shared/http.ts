/** The HTTP layer adapters use, so tests can replace it and no adapter depends on a global. */
export interface HttpRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  url: string
  headers: Record<string, string>
  body?: string
  /** Milliseconds; the client default (20 s) when unset. */
  timeoutMs?: number
  /** The body is read up to this many bytes; a longer one fails with a `TooLargeError`. Unset: no cap. */
  maxBytes?: number
}

/** The error a client throws when a response body is over `HttpRequest.maxBytes`. */
export class TooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`The response is larger than ${maxBytes} bytes`)
    this.name = 'TooLargeError'
  }
}

export interface HttpResponse {
  status: number
  text: string
}

export type HttpClient = (request: HttpRequest) => Promise<HttpResponse>

/** The default client: the platform `fetch` (Node 22, Electron). */
export const fetchClient: HttpClient = async (request) => {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    signal: AbortSignal.timeout(request.timeoutMs ?? 20_000)
  })
  if (request.maxBytes === undefined || !response.body) return { status: response.status, text: await response.text() }
  // Read in chunks and stop at the cap, so a huge body is never held whole.
  const declared = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > request.maxBytes) {
    await response.body.cancel().catch(() => undefined)
    throw new TooLargeError(request.maxBytes)
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > request.maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new TooLargeError(request.maxBytes)
    }
    chunks.push(value)
  }
  return { status: response.status, text: new TextDecoder().decode(Buffer.concat(chunks)) }
}

export function parseJson(text: string): unknown {
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** A network failure in words a user can act on. */
export function describeNetworkError(error: unknown, host: string): string {
  const name = error instanceof Error ? error.name : ''
  if (name === 'TimeoutError' || name === 'AbortError') return `${host} did not answer in time`
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : ''
  const message = cause || (error instanceof Error ? error.message : String(error))
  return `Could not reach ${host}: ${message}`
}
