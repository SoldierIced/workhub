import { CONFIG_VERSION, configSchema, emptyConfig, type WorkhubConfig } from './schema'

/**
 * Migration hook. `MIGRATIONS[n]` turns a raw version-n document into version n+1. A document
 * with no `version` is treated as version 0 (written before versioning, or hand-written).
 */
export type Migration = (raw: Record<string, unknown>) => Record<string, unknown>

export const MIGRATIONS: Readonly<Record<number, Migration>> = {
  0: (raw) => ({ ...raw, version: 1 }),
  // 1 -> 2: optional profile folders, agent console/transcript, the imageInput capability and app
  // options. All of them default, so the document needs no change; the bump keeps an older Workhub
  // from loading (and dropping) the new fields.
  1: (raw) => raw
}

export class ConfigVersionError extends Error {
  constructor(readonly found: number) {
    super(`Config version ${found} is newer than this Workhub (supports up to ${CONFIG_VERSION}).`)
    this.name = 'ConfigVersionError'
  }
}

export class ConfigParseError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid config: ${issues.join('; ')}`)
    this.name = 'ConfigParseError'
  }
}

/** Runs every migration from the document's version up to `CONFIG_VERSION`. */
export function migrateConfig(
  raw: unknown,
  migrations: Readonly<Record<number, Migration>> = MIGRATIONS,
  target: number = CONFIG_VERSION
): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigParseError(['the document is not a JSON object'])
  }
  let doc = raw as Record<string, unknown>
  let version = typeof doc['version'] === 'number' ? doc['version'] : 0
  if (!Number.isInteger(version) || version < 0) throw new ConfigParseError([`bad version ${String(version)}`])
  if (version > target) throw new ConfigVersionError(version)
  while (version < target) {
    const step = migrations[version]
    if (!step) throw new ConfigParseError([`no migration from version ${version}`])
    doc = step(doc)
    version += 1
    doc = { ...doc, version }
  }
  return doc
}

/** Migrates and validates the shape of a raw document (cross-references are checked by `validateConfig`). */
export function parseConfig(raw: unknown): WorkhubConfig {
  if (raw === undefined || raw === null) return emptyConfig()
  const result = configSchema.safeParse(migrateConfig(raw))
  if (!result.success) {
    throw new ConfigParseError(result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`))
  }
  return result.data
}
