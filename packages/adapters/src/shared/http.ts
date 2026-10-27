/** The HTTP layer adapters use, so tests can replace it and no adapter depends on a global. */
export interface HttpRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  url: string
  headers: Record<string, string>
  body?: string
  /** Milliseconds; the client default (20 s) when unset. */
  timeoutMs?: number
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
  return { status: response.status, text: await response.text() }
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
