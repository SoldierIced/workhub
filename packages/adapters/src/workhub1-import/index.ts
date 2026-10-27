/**
 * Reads Workhub 1's settings, read-only, for the import in Settings → General. Workhub 1 is a
 * macOS app that keeps them in UserDefaults; `defaults export <domain> -` prints them as an XML
 * property list without changing anything. Its JSON values are stored as `<data>` (base64).
 */
import { execFile } from 'node:child_process'
import type { Workhub1Settings } from '@workhub/core'

export const WORKHUB1_DOMAIN = 'com.nehuenfortes.workhub'

export type PlistValue = string | number | boolean | Date | Uint8Array | PlistValue[] | { [key: string]: PlistValue }

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function unescape(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
    return ENTITIES[e] ?? m
  })
}

/** A small XML property list parser: dict, array, string, data, integer, real, date, true, false. */
export function parsePlist(xml: string): PlistValue {
  const tokens = [...xml.matchAll(/<(\/?)([a-z]+)(?:\s[^>]*?)?\s*(\/?)>|([^<]+)/gi)]
  let i = 0
  const next = () => tokens[i++]
  const text = (): string => {
    const t = tokens[i]
    if (t && t[4] !== undefined) {
      i++
      return unescape(t[4])
    }
    return ''
  }
  const close = (tag: string) => {
    const t = next()
    if (!t || t[1] !== '/' || t[2] !== tag) throw new Error(`malformed plist near <${tag}>`)
  }
  const value = (): PlistValue => {
    let t = next()
    while (t && t[4] !== undefined) t = next() // whitespace between elements
    if (!t) throw new Error('unexpected end of plist')
    const tag = t[2]!
    const empty = t[3] === '/'
    switch (tag) {
      case 'dict': {
        const out: Record<string, PlistValue> = {}
        if (empty) return out
        for (;;) {
          let k = next()
          while (k && k[4] !== undefined) k = next()
          if (!k) throw new Error('unterminated dict')
          if (k[1] === '/' && k[2] === 'dict') return out
          if (k[2] !== 'key') throw new Error('expected a key in dict')
          const key = text()
          close('key')
          out[key] = value()
        }
      }
      case 'array': {
        const out: PlistValue[] = []
        if (empty) return out
        for (;;) {
          while (tokens[i] && tokens[i]![4] !== undefined) i++
          const t2 = tokens[i]
          if (!t2) throw new Error('unterminated array')
          if (t2[1] === '/' && t2[2] === 'array') {
            i++
            return out
          }
          out.push(value())
        }
      }
      case 'true':
      case 'false':
        return tag === 'true'
      case 'string':
      case 'key': {
        if (empty) return ''
        const s = text()
        close(tag)
        return s
      }
      case 'integer':
      case 'real': {
        const s = text()
        close(tag)
        return Number(s.trim())
      }
      case 'date': {
        const s = text()
        close(tag)
        return new Date(s.trim())
      }
      case 'data': {
        if (empty) return new Uint8Array()
        const s = text()
        close(tag)
        return Uint8Array.from(Buffer.from(s.replace(/\s+/g, ''), 'base64'))
      }
      default:
        throw new Error(`unsupported plist element <${tag}>`)
    }
  }
  // Skip the prolog and the <plist> wrapper.
  while (i < tokens.length && tokens[i]![2] !== 'plist') i++
  i++
  return value()
}

/** A UserDefaults value Workhub 1 wrote as JSON: `<data>` with UTF-8 JSON inside (or a JSON string). */
function json(value: PlistValue | undefined): unknown {
  if (value instanceof Uint8Array) {
    try {
      return JSON.parse(Buffer.from(value).toString('utf8'))
    } catch {
      return undefined
    }
  }
  if (typeof value === 'string') {
    try {
      return JSON.parse(value)
    } catch {
      return undefined
    }
  }
  return undefined
}

/** The parts of Workhub 1's defaults that Workhub 2 imports. */
export function workhub1SettingsFromPlist(xml: string): Workhub1Settings {
  const root = parsePlist(xml)
  if (!root || typeof root !== 'object' || Array.isArray(root) || root instanceof Date || root instanceof Uint8Array) return {}
  const dict = root as Record<string, PlistValue>
  const settings: Workhub1Settings = {}
  const main = json(dict['settings.claude.main'])
  if (main && typeof main === 'object') settings.mainAccount = main as Workhub1Settings['mainAccount']
  const second = json(dict['settings.claude.second'])
  if (second && typeof second === 'object') settings.secondAccount = second as Workhub1Settings['secondAccount']
  const profiles = json(dict['profiles.definitions'])
  if (Array.isArray(profiles)) settings.profiles = profiles as Workhub1Settings['profiles']
  const jira = json(dict['connections.jira'])
  if (jira && typeof jira === 'object' && !Array.isArray(jira)) settings.jira = jira as Workhub1Settings['jira']
  return settings
}

/** Runs `defaults export` (read-only). Only on macOS; null when Workhub 1 has no settings there. */
export function readWorkhub1Settings(domain = WORKHUB1_DOMAIN): Promise<Workhub1Settings | null> {
  if (process.platform !== 'darwin') return Promise.resolve(null)
  return new Promise((resolve, reject) => {
    execFile('defaults', ['export', domain, '-'], { maxBuffer: 32 * 1024 * 1024, timeout: 20_000 }, (err, stdout) => {
      if (err) {
        // `defaults export` fails for a domain that does not exist.
        resolve(null)
        return
      }
      try {
        resolve(workhub1SettingsFromPlist(stdout))
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })
  })
}
