import type { ParsedReview, ReviewSeverity, ScopeAssessment } from './types'

/**
 * Reads the reviewer's reply. The prompt asks for one fenced ```json block; models drift, so this
 * accepts any fenced block, a bare object, trailing commas, smart quotes and loose field names,
 * and picks the last candidate that has a `findings` array. `null` when nothing usable is found:
 * the caller keeps the raw text instead.
 */
export function parseReviewReply(text: string): ParsedReview | null {
  for (const candidate of candidates(text).reverse()) {
    const value = parseLoose(candidate)
    const parsed = value === undefined ? null : normalize(value)
    if (parsed) return parsed
  }
  return null
}

/** Fenced blocks first (in order), then every balanced top-level `{…}` outside them. */
function candidates(text: string): string[] {
  const fenced = [...text.matchAll(/```[ \t]*([A-Za-z0-9_-]*)[^\n]*\n([\s\S]*?)```/g)].map((m) => m[2] ?? '')
  const bare = balancedObjects(text.replace(/```[\s\S]*?```/g, ' '))
  return [...bare, ...fenced]
}

/** Top-level `{…}` spans, string-aware. */
function balancedObjects(text: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = -1
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (c === '\\') i++
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = depth > 0
    else if (c === '{') {
      if (depth === 0) start = i
      depth++
    } else if (c === '}' && depth > 0) {
      depth--
      if (depth === 0 && start >= 0) out.push(text.slice(start, i + 1))
    }
  }
  return out
}

function parseLoose(raw: string): unknown {
  const attempts = [raw, raw.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/,\s*([}\]])/g, '$1')]
  for (const a of attempts) {
    const trimmed = a.trim()
    const from = trimmed.indexOf('{')
    const to = trimmed.lastIndexOf('}')
    if (from < 0 || to <= from) continue
    try {
      return JSON.parse(trimmed.slice(from, to + 1)) as unknown
    } catch {
      // try the next form
    }
  }
  return undefined
}

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined)
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '')
const pick = (o: Obj, ...keys: string[]): unknown => keys.map((k) => o[k]).find((v) => v !== undefined && v !== null)

const SEVERITY: Record<string, ReviewSeverity> = {
  blocker: 'blocker',
  blocking: 'blocker',
  critical: 'blocker',
  major: 'major',
  high: 'major',
  important: 'major',
  minor: 'minor',
  medium: 'minor',
  moderate: 'minor',
  nit: 'nit',
  nitpick: 'nit',
  low: 'nit',
  trivial: 'nit',
  info: 'nit',
  suggestion: 'nit'
}

export function normalizeSeverity(v: unknown): ReviewSeverity {
  return SEVERITY[str(v).toLowerCase()] ?? 'minor'
}

/** `src/a.ts:12`, `src/a.ts:12-20`, `src/a.ts#L12` → file and first line. */
export function splitLocation(file: string, line: unknown): { file?: string; line?: number } {
  let path = file
  let n = typeof line === 'number' && Number.isFinite(line) ? Math.trunc(line) : Number.parseInt(str(line), 10)
  const m = /^(.*?)(?::|#L)(\d+)(?:[-:]\d+)?$/.exec(path)
  if (m && m[1]) {
    path = m[1]
    if (!Number.isFinite(n)) n = Number.parseInt(m[2] ?? '', 10)
  }
  return { ...(path ? { file: path } : {}), ...(Number.isFinite(n) && n > 0 ? { line: n } : {}) }
}

const SCOPES: ScopeAssessment[] = ['proportionate', 'too_demanding', 'scope_creep']

function normalize(value: unknown): ParsedReview | null {
  const root = obj(value)
  const list = root && pick(root, 'findings', 'issues', 'comments')
  if (!root || !Array.isArray(list)) return null
  const findings = list.flatMap((raw) => {
    const f = obj(raw)
    if (!f) return []
    const title = str(pick(f, 'title', 'summary', 'issue', 'message'))
    const why = str(pick(f, 'why', 'reason', 'rationale', 'description', 'details'))
    if (!title && !why) return []
    return [
      {
        severity: normalizeSeverity(pick(f, 'severity', 'level', 'priority')),
        title: title || why.split('\n')[0]!.slice(0, 120),
        ...splitLocation(str(pick(f, 'file', 'path', 'location')), pick(f, 'line', 'lines', 'lineNumber')),
        why,
        fix: str(pick(f, 'fix', 'suggestion', 'recommendation', 'proposed_fix'))
      }
    ]
  })
  const previous = (Array.isArray(root['previous']) ? root['previous'] : Array.isArray(root['verified']) ? root['verified'] : []).flatMap((raw) => {
    const p = obj(raw)
    const id = p && str(p['id']).toUpperCase()
    if (!p || !id) return []
    const status = str(p['status']).toLowerCase()
    const fixed = status === 'fixed' || status === 'resolved' || status === 'done' || p['fixed'] === true
    const note = str(pick(p, 'note', 'comment', 'reason'))
    return [{ id, status: fixed ? ('fixed' as const) : ('open' as const), ...(note ? { note } : {}) }]
  })
  const scopeRaw = obj(root['scope'])
  const assessment = str(scopeRaw ? pick(scopeRaw, 'assessment', 'verdict') : root['scope']).toLowerCase().replace(/[\s-]+/g, '_')
  const escalateRaw = root['escalate']
  const esc = obj(escalateRaw)
  const needed = esc ? esc['needed'] === true || str(esc['needed']).toLowerCase() === 'true' : escalateRaw === true
  return {
    summary: str(root['summary']),
    scope: { assessment: (SCOPES as string[]).includes(assessment) ? (assessment as ScopeAssessment) : 'unknown', note: scopeRaw ? str(pick(scopeRaw, 'note', 'reason', 'comment')) : '' },
    findings,
    previous,
    escalate: { needed, reason: esc ? str(esc['reason']) : '' }
  }
}

/** One `FIXED F3: what changed` line per finding the dev agent says it fixed (case-insensitive, bullets allowed). */
export function parseFixes(text: string): { id: string; note: string }[] {
  const out = new Map<string, string>()
  for (const m of text.matchAll(/^[\s>*\-•]*\**FIXED\**\s+\**(F\d+)\**\s*(?:[:\-–—]\s*(.*))?$/gim)) {
    const id = (m[1] ?? '').toUpperCase()
    if (id && !out.has(id)) out.set(id, (m[2] ?? '').trim())
  }
  return [...out].map(([id, note]) => ({ id, note }))
}

/** One `DISPUTE F3: reason` line per finding the dev agent disagrees with (case-insensitive, bullets allowed). */
export function parseDisputes(text: string): { id: string; reason: string }[] {
  const out = new Map<string, string>()
  for (const m of text.matchAll(/^[\s>*\-•]*\**DISPUTE\**\s+\**(F\d+)\**\s*[:\-–—]\s*(.+)$/gim)) {
    const id = (m[1] ?? '').toUpperCase()
    if (id && !out.has(id)) out.set(id, (m[2] ?? '').trim())
  }
  return [...out].map(([id, reason]) => ({ id, reason }))
}
