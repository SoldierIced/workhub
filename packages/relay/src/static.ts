// Serves the web client's built files next to the WebSocket: one origin for the phone to install
// as an app. Unknown paths without an extension fall back to index.html (the client routes by hash
// and fragment, but a bare path like /pair should still load).
import { createReadStream, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8'
}

/** The file under `root` a request path names, or null when it escapes the root or does not exist. */
export function resolveStatic(root: string, urlPath: string): { path: string; type: string; immutable: boolean } | null {
  const decoded = decodeURIComponent(urlPath.split('?')[0] ?? '/')
  const rootAbs = resolve(root)
  const wanted = normalize(join(rootAbs, decoded))
  if (wanted !== rootAbs && !wanted.startsWith(rootAbs + sep)) return null
  const candidates = extname(decoded) ? [wanted] : [join(wanted, 'index.html'), join(rootAbs, 'index.html')]
  for (const candidate of candidates) {
    try {
      if (!statSync(candidate).isFile()) continue
    } catch {
      continue
    }
    const ext = extname(candidate)
    // Vite names hashed assets under /assets/; they never change under the same name.
    return { path: candidate, type: TYPES[ext] ?? 'application/octet-stream', immutable: candidate.includes(`${sep}assets${sep}`) }
  }
  return null
}

export function serveStatic(root: string, req: IncomingMessage, res: ServerResponse): boolean {
  const found = resolveStatic(root, req.url ?? '/')
  if (!found) return false
  res.setHeader('Content-Type', found.type)
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Cache-Control', found.immutable ? 'public, max-age=31536000, immutable' : 'no-cache')
  if (req.method === 'HEAD') {
    res.end()
    return true
  }
  createReadStream(found.path).pipe(res)
  return true
}
