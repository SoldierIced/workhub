import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import type { HealthTlsMode } from '@workhub/core'
import type { HttpClient } from '../shared/http'
import { ElasticError, normalizeFingerprint } from './client'

export interface TlsPolicy {
  mode: HealthTlsMode
  /** SHA-256 fingerprint of the one certificate accepted in `pinned` mode. */
  fingerprint?: string
}

/** Opens a TLS connection that accepts exactly one certificate (a self-signed cluster) and checks the pin before anything is sent on it. */
function pinnedSocket(url: URL, fingerprint: string, timeoutMs: number): Promise<TLSSocket> {
  const expected = normalizeFingerprint(fingerprint)
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({
      host: url.hostname.replace(/^\[|\]$/g, ''),
      port: Number(url.port || 443),
      // The pin replaces chain validation; without a hostname-bound server name an IP host still works.
      servername: /^[\d.:]+$/.test(url.hostname) ? undefined : url.hostname,
      rejectUnauthorized: false,
      timeout: timeoutMs
    })
    socket.once('secureConnect', () => {
      const actual = normalizeFingerprint(socket.getPeerCertificate().fingerprint256 ?? '')
      if (actual !== expected) {
        socket.destroy()
        reject(new ElasticError('The Elasticsearch certificate does not match the pinned fingerprint', 'untrustedCertificate'))
        return
      }
      resolve(socket)
    })
    socket.once('timeout', () => {
      socket.destroy()
      reject(Object.assign(new Error('connection timed out'), { name: 'TimeoutError' }))
    })
    socket.once('error', reject)
  })
}

/**
 * The HTTP layer for Elasticsearch, with the TLS policy of the connection: the system trust store
 * (default), one pinned certificate, or no validation. Built on `node:http(s)` because `fetch`
 * cannot relax certificate checks for a single host.
 */
export function createElasticTransport(tls: TlsPolicy): HttpClient {
  return async (req) => {
    const url = new URL(req.url)
    const timeoutMs = req.timeoutMs ?? 20_000
    const secure = url.protocol === 'https:'
    const socket = secure && tls.mode === 'pinned' ? await pinnedSocket(url, tls.fingerprint ?? '', timeoutMs) : undefined
    return new Promise((resolve, reject) => {
      const options = {
        method: req.method,
        hostname: url.hostname.replace(/^\[|\]$/g, ''),
        port: url.port || (secure ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        headers: { ...req.headers, ...(req.body === undefined ? {} : { 'Content-Length': Buffer.byteLength(req.body) }) },
        ...(secure && tls.mode === 'insecure' ? { rejectUnauthorized: false } : {}),
        ...(socket ? { agent: false as const, createConnection: () => socket } : {})
      }
      const out = (secure ? httpsRequest : httpRequest)(options, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }))
        res.on('error', reject)
      })
      out.setTimeout(timeoutMs, () => out.destroy(Object.assign(new Error('request timed out'), { name: 'TimeoutError' })))
      out.on('error', reject)
      out.end(req.body)
    })
  }
}
