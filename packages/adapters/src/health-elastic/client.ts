import { HealthConnectionError, type HealthTlsMode } from '@workhub/core'
import type { HttpClient } from '../shared/http'
import { at, num, str, type Json } from './json'

/** Why an Elasticsearch call failed. The first four are about the connection as a whole; the others about one query. */
export type ElasticErrorKind = 'notConfigured' | 'unreachable' | 'untrustedCertificate' | 'unauthorized' | 'timedOut' | 'badResponse'

export class ElasticError extends Error {
  constructor(
    message: string,
    readonly kind: ElasticErrorKind,
    readonly status?: number
  ) {
    super(message)
    this.name = 'ElasticError'
  }

  /** The failure applies to the whole connection, so the remaining queries of a refresh are pointless. */
  get isConnectionLevel(): boolean {
    return this.kind !== 'badResponse' && this.kind !== 'timedOut'
  }
}

export type ElasticAuth = { mode: 'apiKey'; secret: string } | { mode: 'basic'; username: string; secret: string }

export interface ElasticClientOptions {
  /** Base URL of Elasticsearch. */
  baseUrl: string
  auth: ElasticAuth
  http: HttpClient
  /** One query may take this long before it is dropped. */
  timeoutMs?: number
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/**
 * The Elasticsearch URL when it is usable: `https`, or `http` only for a loopback host (the
 * credentials would travel in clear text otherwise). Null otherwise.
 */
export function normalizeElasticUrl(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }
  const loopback = LOOPBACK.has(url.hostname.toLowerCase())
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && loopback))) return null
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`
}

/** The `Authorization` header value. HTTP Basic joins user and password with a colon, so the user cannot contain one. */
export function authorizationHeader(auth: ElasticAuth): string {
  if (auth.mode === 'apiKey') return `ApiKey ${auth.secret}`
  return `Basic ${Buffer.from(`${auth.username}:${auth.secret}`).toString('base64')}`
}

/** A user name usable for HTTP Basic, or the reason it is not. */
export function usernameProblem(username: string): 'empty' | 'colon' | null {
  const u = username.trim()
  if (!u) return 'empty'
  return u.includes(':') ? 'colon' : null
}

/** Index patterns may contain commas and wildcards; everything else in a segment is percent-encoded. */
export function indexPath(index: string): string {
  return index
    .split(',')
    .map((part) => encodeURIComponent(part.trim()))
    .join(',')
}

/** A SHA-256 fingerprint as lowercase hex without colons or spaces. */
export function normalizeFingerprint(text: string): string {
  return text.replace(/[^0-9a-fA-F]/g, '').toLowerCase()
}

export const isFingerprint = (text: string): boolean => normalizeFingerprint(text).length === 64

/** A read-only client: `POST <index>/_search` and `<index>/_count`. The secret is passed in at call time and never logged. */
export class ElasticClient {
  private readonly baseUrl: string
  private readonly header: string
  private readonly http: HttpClient
  private readonly timeoutMs: number

  constructor(options: ElasticClientOptions) {
    const base = normalizeElasticUrl(options.baseUrl)
    if (!base) throw new ElasticError('The Elasticsearch URL must be https:// (http:// only for localhost)', 'notConfigured')
    if (options.auth.mode === 'basic') {
      const problem = usernameProblem(options.auth.username)
      if (problem) throw new ElasticError(problem === 'empty' ? 'The username is empty' : 'The username cannot contain a colon', 'notConfigured')
    }
    if (!options.auth.secret) throw new ElasticError('No credential is stored for this connection', 'notConfigured')
    this.baseUrl = base
    this.header = authorizationHeader(options.auth)
    this.http = options.http
    this.timeoutMs = options.timeoutMs ?? 20_000
  }

  private async post(index: string, endpoint: '_search' | '_count', body: unknown): Promise<Json> {
    const url = `${this.baseUrl}/${indexPath(index)}/${endpoint}`
    let response
    try {
      response = await this.http({
        method: 'POST',
        url,
        headers: { Authorization: this.header, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        timeoutMs: this.timeoutMs
      })
    } catch (error) {
      throw classifyNetworkError(error, this.timeoutMs)
    }
    if (response.status === 401 || response.status === 403) throw new ElasticError(`Elasticsearch refused the credentials (HTTP ${response.status})`, 'unauthorized', response.status)
    let parsed: Json
    try {
      parsed = response.text ? JSON.parse(response.text) : undefined
    } catch {
      parsed = undefined
    }
    if (response.status < 200 || response.status >= 300) {
      const detail = str(at(parsed, 'error', 'reason')) ?? str(at(parsed, 'error', 'type')) ?? ''
      throw new ElasticError(detail ? `Elasticsearch answered HTTP ${response.status}: ${detail}` : `Elasticsearch answered HTTP ${response.status}`, 'badResponse', response.status)
    }
    if (parsed === undefined) throw new ElasticError('Elasticsearch answered something that is not JSON', 'badResponse', response.status)
    return parsed
  }

  search(index: string, body: Record<string, unknown>): Promise<Json> {
    return this.post(index, '_search', body)
  }

  /** `_count` with the given query clause. */
  async count(index: string, query: Record<string, unknown>): Promise<number> {
    const result = await this.post(index, '_count', { query })
    return num(at(result, 'count')) ?? 0
  }
}

const CERT_CODES = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME|FINGERPRINT/i

/** DNS, refused connections and TLS failures in words a user can act on (typically the VPN is down). */
export function classifyNetworkError(error: unknown, timeoutMs: number): ElasticError {
  if (error instanceof ElasticError) return error
  const name = error instanceof Error ? error.name : ''
  if (name === 'TimeoutError' || name === 'AbortError') return new ElasticError(`The query took longer than ${Math.round(timeoutMs / 1000)} s and was dropped`, 'timedOut')
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : undefined
  const code = String((cause as { code?: string } | undefined)?.code ?? (error as { code?: string } | undefined)?.code ?? '')
  const detail = cause?.message ?? (error instanceof Error ? error.message : String(error))
  if (CERT_CODES.test(code) || CERT_CODES.test(detail)) return new ElasticError('The Elasticsearch certificate was rejected', 'untrustedCertificate')
  return new ElasticError(`Elasticsearch is unreachable (is the VPN up?): ${detail}`, 'unreachable')
}

/** Connection-level failures stop a refresh as a `HealthConnectionError`; a failure of one query is returned as its message. */
export function toConnectionError(error: ElasticError): HealthConnectionError {
  const kind = error.kind === 'unauthorized' || error.kind === 'untrustedCertificate' || error.kind === 'notConfigured' ? error.kind : 'unreachable'
  return new HealthConnectionError(error.message, kind)
}

export type { HealthTlsMode }
