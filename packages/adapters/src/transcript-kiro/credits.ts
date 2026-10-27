/**
 * The credits each Kiro turn used, with the time it ended, from the session files under
 * `~/.kiro/sessions` (read-only). Kiro does not expose the credits left or its plan limits
 * locally, so Workhub shows what was spent per day and per week instead (see `creditSpend`).
 *
 * - ACP sessions, `cli/<id>.json`: `user_turn_metadatas[].metering_usage` and `end_timestamp`
 *   (the file's `updated_at` when a turn has none).
 * - Chat sessions, `<hash>/sess_<id>/messages.jsonl`: `usage_summary` lines, by line timestamp.
 *
 * Files last written before `since` are skipped without being read.
 */
import { createReadStream } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { CreditEntry } from '@workhub/core'
import { arr, num, obj, parseLine, toMillis, type Obj } from '../shared/reader-utils'
import { defaultKiroDir } from './reader'

const turnCredits = (metering: unknown): number | undefined => {
  const values = arr(metering).map((m) => num(obj(m)?.['value'])).filter((v): v is number => v !== undefined)
  return values.length ? values.reduce((a, b) => a + b, 0) : undefined
}

/** The turns of one ACP session file (`cli/<id>.json`). */
export function kiroCliCreditEntries(text: string): CreditEntry[] {
  let raw: Obj | undefined
  try {
    raw = obj(JSON.parse(text))
  } catch {
    return []
  }
  const fallback = toMillis(raw?.['updated_at'])
  const turns = arr(obj(obj(raw?.['session_state'])?.['conversation_metadata'])?.['user_turn_metadatas'])
  return turns.flatMap((t) => {
    const turn = obj(t)
    const credits = turnCredits(turn?.['metering_usage'])
    const at = toMillis(turn?.['end_timestamp']) ?? fallback
    return credits !== undefined && at !== undefined ? [{ at, credits }] : []
  })
}

/** One `messages.jsonl` line of a chat session, when it is a `usage_summary`. */
export function kiroChatCreditEntry(line: string): CreditEntry | null {
  const entry = parseLine(line)
  const payload = obj(entry?.['payload'])
  if (!entry || payload?.['type'] !== 'usage_summary') return null
  const at = toMillis(entry['timestamp'])
  const values = arr(payload['promptTurnSummaries']).map((s) => num(obj(s)?.['usage'])).filter((v): v is number => v !== undefined)
  if (at === undefined || !values.length) return null
  return { at, credits: values.reduce((a, b) => a + b, 0) }
}

async function modifiedSince(path: string, since: number): Promise<boolean> {
  try {
    return (await stat(path)).mtimeMs >= since
  } catch {
    return false
  }
}

async function chatEntries(file: string): Promise<CreditEntry[]> {
  const out: CreditEntry[] = []
  const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      // Cheap pre-filter: most lines are messages and tool calls.
      if (!line.includes('usage_summary')) continue
      const e = kiroChatCreditEntry(line)
      if (e) out.push(e)
    }
  } catch {
    // An unreadable file adds nothing.
  }
  return out
}

/** Every Kiro turn that ended at or after `since`, from both session layouts. Never throws. */
export async function readKiroCreditEntries(options: { kiroDir?: string; since: number }): Promise<CreditEntry[]> {
  const sessionsDir = join(options.kiroDir ?? defaultKiroDir(), 'sessions')
  const since = options.since
  const out: CreditEntry[] = []

  const cliDir = join(sessionsDir, 'cli')
  const cliNames = await readdir(cliDir).catch(() => [] as string[])
  for (const name of cliNames) {
    if (!name.endsWith('.json')) continue
    const path = join(cliDir, name)
    if (!(await modifiedSince(path, since))) continue
    const text = await readFile(path, 'utf8').catch(() => '')
    out.push(...kiroCliCreditEntries(text).filter((e) => e.at >= since))
  }

  const folders = await readdir(sessionsDir).catch(() => [] as string[])
  for (const folder of folders) {
    if (folder === 'cli') continue
    const names = await readdir(join(sessionsDir, folder)).catch(() => [] as string[])
    for (const name of names) {
      if (!name.startsWith('sess_')) continue
      const file = join(sessionsDir, folder, name, 'messages.jsonl')
      if (!(await modifiedSince(file, since))) continue
      out.push(...(await chatEntries(file)).filter((e) => e.at >= since))
    }
  }
  return out.sort((a, b) => a.at - b.at)
}
