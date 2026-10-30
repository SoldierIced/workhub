/**
 * The flow-map files: `<dataDir>/flow-maps/<id>.json`, one map each, written by a person or by an
 * agent (the `workhub-flow-map` skill posts them to the control endpoint). They are read on every
 * ask, so a file dropped in the folder shows up on the next refresh without a restart.
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseFlowMap, type FlowMap } from '@workhub/core'
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
      ? { id: f.map.id, name: f.map.name, file: f.file, ...(f.map.description ? { description: f.map.description } : {}), ...(f.map.environmentId ? { environmentId: f.map.environmentId } : {}), nodes: f.map.nodes.length, edges: f.map.edges.length }
      : { id: f.file.split(/[\\/]/).pop()!.replace(/\.json$/, ''), name: f.file.split(/[\\/]/).pop()!, file: f.file, nodes: 0, edges: 0, error: f.error ?? 'unreadable' }
  )
}

export type SaveFlowMapResult = { ok: true; file: string; id: string } | { ok: false; errors: string[] }

/** Validates and writes a map as `<dir>/<id>.json` (atomically); an existing map with the id is replaced. */
export function saveFlowMap(dir: string, input: unknown): SaveFlowMapResult {
  const parsed = parseFlowMap(input)
  if (!parsed.ok) return parsed
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${parsed.map.id}.json`)
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(parsed.map, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
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
