// Results larger than one protocol line (HOST_MAX_LINE_BYTES): the host sends the result's JSON in
// byte-bounded pieces, the first one as the answer and the rest on request, and the app joins them
// before parsing. A result that fits is sent whole, as before. Nothing is cut or dropped, so a long
// session's history or transcript snapshot arrives exactly as the host read it.
//
//   answer   {value}                      the whole result
//          | {chunk, cursor}              the first piece; more follow
//   <port>.next {cursor} → {chunk, cursor?}   the next piece; no cursor on the last one
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { utf8ByteLength } from '@workhub/core'
import { HostRequestError, type HostClient } from '../client'
import { HostHandlerError, type HostHandlers } from '../server'
import { parseParams, parseResult } from './shared'

/** The most bytes a piece takes once it is written as a JSON string: half the line cap, so the envelope always fits. */
export const RESULT_CHUNK_BYTES = 512 * 1024
/** How long the rest of a result waits for the app to ask for it. */
export const RESULT_CHUNK_TTL_MS = 120_000
/** Results whose rest is kept at once; the oldest goes first. */
export const RESULT_CHUNK_MAX_PENDING = 16

interface Pending {
  text: string
  offset: number
  expires: number
}

export interface ResultChunksOptions {
  chunkBytes?: number
  ttlMs?: number
  maxPending?: number
  now?: () => number
}

/** Bytes `s` takes as a JSON string in the line (quotes and escapes included). */
const encodedBytes = (s: string): number => utf8ByteLength(JSON.stringify(s))

const isHighSurrogate = (c: number): boolean => c >= 0xd800 && c <= 0xdbff

/**
 * The end of the next piece of `text` from `start`: as long as it fits in `budget` bytes once
 * encoded, never splitting a surrogate pair, and at least one character.
 */
function pieceEnd(text: string, start: number, budget: number): number {
  // Most JSON is ASCII with few escapes: start from the budget and shrink only when it does not fit.
  let length = Math.min(text.length - start, budget)
  for (;;) {
    let end = start + length
    if (end < text.length && end > start + 1 && isHighSurrogate(text.charCodeAt(end - 1))) end--
    if (end - start <= 1 || encodedBytes(text.slice(start, end)) <= budget) return Math.max(end, start + 1)
    length = Math.max(1, Math.floor(length / 2))
  }
}

/** Host side: one port's large results, and the `<method>` that hands out their next pieces. */
export class ResultChunks {
  private readonly pending = new Map<string, Pending>()
  private readonly chunkBytes: number
  private readonly ttlMs: number
  private readonly maxPending: number
  private readonly now: () => number

  constructor(
    readonly method: string,
    options: ResultChunksOptions = {}
  ) {
    this.chunkBytes = options.chunkBytes ?? RESULT_CHUNK_BYTES
    this.ttlMs = options.ttlMs ?? RESULT_CHUNK_TTL_MS
    this.maxPending = options.maxPending ?? RESULT_CHUNK_MAX_PENDING
    this.now = options.now ?? Date.now
  }

  /** The answer for `value`: whole when it fits in one piece, else its first piece and a cursor. */
  wrap(value: unknown): { value: unknown } | { chunk: string; cursor: string } {
    const text = JSON.stringify(value ?? null)
    if (encodedBytes(text) <= this.chunkBytes) return { value: value ?? null }
    this.expire()
    while (this.pending.size >= this.maxPending) this.pending.delete(this.pending.keys().next().value!)
    const cursor = randomUUID()
    const end = pieceEnd(text, 0, this.chunkBytes)
    this.pending.set(cursor, { text, offset: end, expires: this.now() + this.ttlMs })
    return { chunk: text.slice(0, end), cursor }
  }

  /** Results whose rest is still waiting. */
  get size(): number {
    return this.pending.size
  }

  get handlers(): HostHandlers {
    return {
      [this.method]: (params) => {
        const { cursor } = parseParams(nextParams, params, this.method)
        this.expire()
        const p = this.pending.get(cursor)
        if (!p) throw new HostHandlerError('bad_params', `${this.method}: unknown or expired cursor`)
        const end = pieceEnd(p.text, p.offset, this.chunkBytes)
        const chunk = p.text.slice(p.offset, end)
        if (end >= p.text.length) {
          this.pending.delete(cursor)
          return { chunk }
        }
        p.offset = end
        p.expires = this.now() + this.ttlMs
        return { chunk, cursor }
      }
    }
  }

  private expire(): void {
    const now = this.now()
    for (const [cursor, p] of this.pending) if (p.expires <= now) this.pending.delete(cursor)
  }
}

const nextParams = z.object({ cursor: z.string().min(1) })
const answerResult = z.union([z.object({ value: z.unknown() }), z.object({ chunk: z.string(), cursor: z.string().min(1) })])
const nextResult = z.object({ chunk: z.string(), cursor: z.string().min(1).optional() })

/**
 * App side: the result an answer of `method` stands for, asking `nextMethod` for the rest of a
 * result sent in pieces.
 */
export async function joinChunks(client: HostClient, answer: unknown, method: string, nextMethod: string, timeoutMs?: number): Promise<unknown> {
  const first = parseResult(answerResult, answer, method)
  if ('value' in first) return first.value
  const pieces = [first.chunk]
  let cursor: string | undefined = first.cursor
  while (cursor) {
    const next: z.infer<typeof nextResult> = parseResult(nextResult, await client.request(nextMethod, { cursor }, { timeoutMs }), nextMethod)
    pieces.push(next.chunk)
    cursor = next.cursor
  }
  try {
    return JSON.parse(pieces.join(''))
  } catch {
    throw new HostRequestError('internal', `${method}: the pieces of the result from the host do not join`)
  }
}
