import { EMPTY_PR_EVENT_STATE, type PrEventState, type PrEventStore, type PrProfileState } from '@workhub/core'
import { readFileIfExists, SerialQueue, writeFileAtomic } from '../shared/atomic-file'

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

/** Keeps what is usable of one profile's memory; anything malformed is dropped, which only means that part is seeded again. */
function readProfile(raw: unknown): PrProfileState | null {
  if (!isRecord(raw) || !isRecord(raw['mine']) || !Array.isArray(raw['seen'])) return null
  const mine: PrProfileState['mine'] = {}
  for (const [url, snap] of Object.entries(raw['mine'])) {
    if (isRecord(snap) && typeof snap['url'] === 'string' && typeof snap['title'] === 'string' && typeof snap['name'] === 'string') mine[url] = snap as unknown as PrProfileState['mine'][string]
  }
  const requested = Array.isArray(raw['requested']) ? raw['requested'].filter((u): u is string => typeof u === 'string') : undefined
  return { mine, ...(requested ? { requested } : {}), seen: raw['seen'].filter((id): id is string => typeof id === 'string') }
}

/**
 * The pull request sync memory on one JSON file. A missing, unreadable or newer file loads as an
 * empty memory, which makes the next sync a seeding one: it never reports the current state as new.
 */
export class JsonPrEventStore implements PrEventStore {
  private readonly queue = new SerialQueue()

  constructor(readonly path: string) {}

  async load(): Promise<PrEventState> {
    const text = await readFileIfExists(this.path)
    if (text === null) return { ...EMPTY_PR_EVENT_STATE, profiles: {} }
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      return { ...EMPTY_PR_EVENT_STATE, profiles: {} }
    }
    if (!isRecord(raw) || raw['version'] !== 1 || !isRecord(raw['profiles'])) return { ...EMPTY_PR_EVENT_STATE, profiles: {} }
    const profiles: PrEventState['profiles'] = {}
    for (const [id, value] of Object.entries(raw['profiles'])) {
      const profile = readProfile(value)
      if (profile) profiles[id] = profile
    }
    return { version: 1, profiles }
  }

  async save(state: PrEventState): Promise<void> {
    await this.queue.run(() => writeFileAtomic(this.path, `${JSON.stringify(state)}\n`))
  }
}
