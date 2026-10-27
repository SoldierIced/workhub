import { ConfigParseError, configSchema, parseConfig, type ConfigStore, type WorkhubConfig } from '@workhub/core'
import { readFileIfExists, SerialQueue, writeFileAtomic } from '../shared/atomic-file'

/**
 * ConfigStore on one JSON file. The path is injected (the app passes its data folder).
 * A missing file loads as an empty config; a corrupt or newer file throws and is never
 * overwritten by `load`.
 */
export class JsonConfigStore implements ConfigStore {
  private readonly queue = new SerialQueue()

  constructor(readonly path: string) {}

  async load(): Promise<WorkhubConfig> {
    const text = await readFileIfExists(this.path)
    if (text === null) return parseConfig(null)
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch (err) {
      throw new ConfigParseError([`${this.path} is not valid JSON: ${(err as Error).message}`])
    }
    return parseConfig(raw)
  }

  async save(config: WorkhubConfig): Promise<void> {
    // Validate the shape before writing, so a bad object never reaches the disk.
    const checked = configSchema.parse(config)
    await this.queue.run(() => writeFileAtomic(this.path, `${JSON.stringify(checked, null, 2)}\n`))
  }
}
