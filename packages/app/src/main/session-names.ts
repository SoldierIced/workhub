import { StateFile } from './state-file'

/** Longest name kept; a longer one is cut. */
export const MAX_SESSION_NAME = 120

/** Where the names the user gave sessions are kept, keyed by the session's stable identity. */
export interface SessionNameStore {
  get(identity: string): string | undefined
  /** Empty or null forgets the name. Returns the name stored (trimmed, cut), or undefined. */
  set(identity: string, name: string | null): string | undefined
  /** A session got its real identity: its name follows it. */
  move(from: string, to: string): void
}

/** A name as stored: one line, trimmed, at most `MAX_SESSION_NAME` characters; undefined when empty. */
export function cleanSessionName(name: string | null | undefined): string | undefined {
  if (typeof name !== 'string') return undefined
  const one = name.replace(/\s+/g, ' ').trim().slice(0, MAX_SESSION_NAME).trim()
  return one || undefined
}

interface NamesFile {
  names: Record<string, string>
}

/** Session names in a JSON file of the data folder (Workhub 1 kept them per session too). */
export class SessionNames implements SessionNameStore {
  private readonly names: Map<string, string>

  constructor(private readonly file: StateFile<NamesFile>) {
    const stored = file.load({ names: {} }).names
    this.names = new Map(Object.entries(stored && typeof stored === 'object' ? stored : {}).filter((e): e is [string, string] => typeof e[1] === 'string'))
  }

  get(identity: string): string | undefined {
    return this.names.get(identity)
  }

  set(identity: string, name: string | null): string | undefined {
    const clean = cleanSessionName(name)
    if (clean === this.names.get(identity)) return clean
    if (clean) this.names.set(identity, clean)
    else this.names.delete(identity)
    this.save()
    return clean
  }

  move(from: string, to: string): void {
    const name = this.names.get(from)
    if (name === undefined || from === to) return
    this.names.delete(from)
    this.names.set(to, name)
    this.save()
  }

  flush(): void {
    this.file.flush()
  }

  private save(): void {
    this.file.save({ names: Object.fromEntries(this.names) })
  }
}
