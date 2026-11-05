/**
 * The flow-map files: `<dataDir>/flow-maps/<id>.json`, one map each, written by a person or by an
 * agent (the `workhub-flow-map` skill posts them to the control endpoint). They are read on every
 * ask, so a file dropped in the folder shows up on the next refresh without a restart.
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseFlowMap, setJsonField, type FlowMap, type FlowMapAlerts } from '@workhub/core'
import type { FlowMapSummary } from '../shared/health-api'
import type { FlowMapImportResult } from '../shared/flow-maps-api'

export const FLOW_MAPS_FOLDER = 'flow-maps'

export interface FlowMapFile {
  file: string
  map?: FlowMap
  error?: string
}

/** Every `.json` of the folder, parsed; a bad file is listed with its error so the screen can say so. */
export function readFlowMapFiles(dir: string): FlowMapFile[] {
  let names: string[]
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json')).sort()
  } catch {
    return []
  }
  return names.map((name) => {
    const file = join(dir, name)
    try {
      const parsed = parseFlowMap(JSON.parse(readFileSync(file, 'utf8')))
      return parsed.ok ? { file, map: parsed.map } : { file, error: parsed.errors.slice(0, 5).join('; ') }
    } catch (e) {
      return { file, error: e instanceof Error ? e.message : String(e) }
    }
  })
}

export function flowMapSummaries(files: FlowMapFile[]): FlowMapSummary[] {
  return files.map((f) =>
    f.map
      ? { id: f.map.id, name: f.map.name, file: f.file, ...(f.map.description ? { description: f.map.description } : {}), ...(f.map.group ? { group: f.map.group } : {}), ...(f.map.environmentId ? { environmentId: f.map.environmentId } : {}), nodes: f.map.nodes.length, edges: f.map.edges.length }
      : { id: f.file.split(/[\\/]/).pop()!.replace(/\.json$/, ''), name: f.file.split(/[\\/]/).pop()!, file: f.file, nodes: 0, edges: 0, error: f.error ?? 'unreadable' }
  )
}

export type SaveFlowMapResult = { ok: true; file: string; id: string } | { ok: false; errors: string[] }

function writeAtomically(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, text, { mode: 0o600 })
  renameSync(tmp, file)
}

/** The `alerts` written in a map's file as they are in the JSON, or undefined (no file, no field, not JSON). */
function storedAlerts(file: string): unknown {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>)['alerts'] : undefined
  } catch {
    return undefined
  }
}

/**
 * Validates and writes a map as `<dir>/<id>.json` (atomically); an existing map with the id is
 * replaced. `keepAlerts` (the control endpoint): a posted map without `alerts` keeps the limits the
 * stored map has, so an agent that redraws a map does not drop the limits set in Settings → Alerts.
 */
export function saveFlowMap(dir: string, input: unknown, options: { keepAlerts?: boolean } = {}): SaveFlowMapResult {
  let candidate = input
  if (options.keepAlerts && input && typeof input === 'object' && !Array.isArray(input) && !('alerts' in input)) {
    const id = (input as Record<string, unknown>)['id']
    const kept = typeof id === 'string' && SAFE_ID.test(id) && !id.includes('..') ? storedAlerts(join(dir, `${id}.json`)) : undefined
    if (kept !== undefined) candidate = { ...input, alerts: kept }
  }
  let parsed = parseFlowMap(candidate)
  // Limits that no longer fit the redrawn map (a part removed) are dropped rather than refusing the map.
  if (!parsed.ok && candidate !== input) parsed = parseFlowMap(input)
  if (!parsed.ok) return parsed
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${parsed.map.id}.json`)
  writeAtomically(file, JSON.stringify(parsed.map, null, 2) + '\n')
  return { ok: true, file, id: parsed.map.id }
}

/** The file of a map by id: `<id>.json`, else whichever file holds a map with that id. */
function flowMapFileOf(dir: string, mapId: string): string | null {
  const direct = join(dir, `${mapId}.json`)
  const files = readFlowMapFiles(dir)
  if (files.some((f) => f.file === direct && f.map?.id === mapId)) return direct
  return files.find((f) => f.map?.id === mapId)?.file ?? null
}

/**
 * Writes a map's `alerts` (null removes them) into its file, atomically. The new map is validated
 * like any map (a part that does not exist or has no measure is refused), and every other byte of
 * the file stays as it was.
 */
export function setFlowMapAlerts(dir: string, mapId: string, alerts: FlowMapAlerts | null): SaveFlowMapResult {
  if (typeof mapId !== 'string' || !SAFE_ID.test(mapId) || mapId.includes('..')) return { ok: false, errors: ['id: not a map id'] }
  const file = flowMapFileOf(dir, mapId)
  if (!file) return { ok: false, errors: ['This flow map is no longer in the folder'] }
  let text: string
  let raw: Record<string, unknown>
  try {
    text = readFileSync(file, 'utf8')
    const parsed = JSON.parse(text) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, errors: ['(root): not a JSON object'] }
    raw = parsed as Record<string, unknown>
  } catch (e) {
    return { ok: false, errors: [e instanceof Error ? e.message : String(e)] }
  }
  const next: Record<string, unknown> = { ...raw }
  if (alerts === null) delete next['alerts']
  else next['alerts'] = alerts
  const parsed = parseFlowMap(next)
  if (!parsed.ok) return parsed
  // What is written is what was validated (unknown keys stripped, defaults filled), so the file never holds what the app would not read.
  const value = alerts === null ? undefined : parsed.map.alerts
  let out: string
  try {
    out = setJsonField(text, 'alerts', value)
    if (JSON.stringify(JSON.parse(out)['alerts']) !== JSON.stringify(value)) throw new Error('mismatch')
  } catch {
    out = JSON.stringify(value === undefined ? (({ alerts: _drop, ...rest }) => rest)(raw) : { ...raw, alerts: value }, null, 2) + '\n'
  }
  writeAtomically(file, out)
  return { ok: true, file, id: parsed.map.id }
}

const SAFE_ID = /^[a-z0-9][a-z0-9-_.]*$/i

/** Deletes `<dir>/<id>.json`; false when the id is not a map id or there is no such file. */
export function deleteFlowMap(dir: string, id: string): boolean {
  if (typeof id !== 'string' || !SAFE_ID.test(id) || id.includes('..')) return false
  try {
    unlinkSync(join(dir, `${id}.json`))
    return true
  } catch {
    return false
  }
}

/** Reads each file as a map and stores the valid ones; a file that does not parse is reported, the rest still import. */
export function importFlowMapFiles(dir: string, files: readonly string[]): FlowMapImportResult[] {
  return files.map((file): FlowMapImportResult => {
    let input: unknown
    try {
      input = JSON.parse(readFileSync(file, 'utf8'))
    } catch (e) {
      return { file, ok: false, errors: [e instanceof Error ? e.message : String(e)] }
    }
    const r = saveFlowMap(dir, input)
    return r.ok ? { file, ok: true, id: r.id } : { file, ok: false, errors: r.errors }
  })
}
