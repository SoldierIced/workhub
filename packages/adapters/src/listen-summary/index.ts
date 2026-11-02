import { DEFAULT_LISTEN_MODEL, LISTEN_SYSTEM_PROMPT, listenPrompt, spokenSummary, type ListenSummaryResult } from '@workhub/core'
import { parseOneshotOutput, runOneshot, type OneshotOutcome, type OneshotRunOptions } from '../chat-slack/agent-source'

export type { ListenSummaryResult }

export interface ListenSummarizerOptions extends OneshotRunOptions {
  /** Where the query runs (it reads no files: it has no tools). */
  cwd: string
  /** The helper gives up after this long; default 45 s. */
  timeoutSeconds?: number
  /** Stand-in for running `oneshot.mjs` (tests). */
  run?: (line: string, killAfterMs: number, signal?: AbortSignal) => Promise<string>
}

export interface ListenSummaryRequest {
  /** The agent message, as Markdown. */
  text: string
  /** A Claude model alias or id; empty: `DEFAULT_LISTEN_MODEL`. */
  model?: string
  /** The Claude config folder (account) the query runs with; unset: Claude Code's default. */
  configDir?: string
  signal?: AbortSignal
}

const DEFAULT_TIMEOUT_SECONDS = 45
/** Claude Code's words for a missing or refused sign-in. */
const NO_LOGIN = /not logged in|please run \/login|invalid api key|authentication|unauthorized|\b401\b|credentials/i

/** The result for what `oneshot.mjs` printed: its answer cleaned for speech, or why it failed. */
export function toSummaryResult(outcome: OneshotOutcome | null, cancelled = false): ListenSummaryResult {
  if (cancelled) return { ok: false, failure: 'cancelled', error: 'Cancelled.' }
  if (!outcome) return { ok: false, failure: 'failed', error: 'The summary helper returned no answer.' }
  const cost = outcome.costUsd !== undefined ? { costUsd: outcome.costUsd } : {}
  if (!outcome.ok) {
    const error = outcome.errorMessage ?? 'The summary failed.'
    const failure = outcome.rateLimited ? 'rateLimited' : /timed out/i.test(error) ? 'timeout' : NO_LOGIN.test(error) ? 'noAccount' : 'failed'
    return { ok: false, failure, error, ...cost }
  }
  const summary = spokenSummary(outcome.result)
  if (!summary) return { ok: false, failure: 'failed', error: 'The summary was empty.', ...cost }
  return { ok: true, summary, ...cost }
}

/**
 * Summarizes an agent message for listening with one headless Claude query (Haiku by default) on
 * `oneshot.mjs` in its `bare` mode: no tools, no settings, no MCP servers, one turn. It only reads
 * the text it is given.
 */
export class ListenSummarizer {
  constructor(private readonly options: ListenSummarizerOptions) {}

  async summarize(request: ListenSummaryRequest): Promise<ListenSummaryResult> {
    const timeoutSeconds = this.options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS
    const line = JSON.stringify({
      prompt: listenPrompt(request.text),
      systemPrompt: LISTEN_SYSTEM_PROMPT,
      cwd: this.options.cwd,
      model: request.model?.trim() || DEFAULT_LISTEN_MODEL,
      maxTurns: 1,
      timeoutSeconds,
      bare: true,
      ...(request.configDir ? { configDir: request.configDir } : {})
    })
    const killAfterMs = (timeoutSeconds + 10) * 1000
    const run = this.options.run ?? ((l: string, ms: number, signal?: AbortSignal) => runOneshot(this.options, l, ms, signal))
    const out = await run(line, killAfterMs, request.signal)
    return toSummaryResult(parseOneshotOutput(out), request.signal?.aborted === true)
  }
}
