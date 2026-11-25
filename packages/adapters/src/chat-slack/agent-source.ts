import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { parseDigest, watchPrompt, type ChatReadMode, type ChatReadRequest, type ChatReadResult, type ChatSource, type RunUsage } from '@workhub/core'

export interface SlackAgentSourceOptions {
  /** Folder holding `oneshot.mjs` (Workhub 1's headless read-only query on the Claude Agent SDK). */
  bridgeDir: string
  /** Defaults to `oneshot.mjs`. */
  script?: string
  /** Node to run it with; defaults to this process (Electron as Node). */
  nodeCommand?: string
  /** Where the query runs (no files are read: it has no built-in tools). */
  cwd: string
  timeoutSeconds?: number
}

/** What `oneshot.mjs` prints as its last line. */
export interface OneshotOutcome {
  ok: boolean
  result: string
  errorMessage?: string
  rateLimited: boolean
  resetsAt?: string
  costUsd?: number
  /** The run's tokens and the model that answered; absent when it ended before a result. */
  usage?: RunUsage
  /** `light`: only the Slack plugin was loaded; `full`: the user's settings; `bare`: nothing at all. */
  readMode?: ChatReadMode | 'bare'
  slackTools: string[]
  deniedTools: string[]
}

/** The `usage` and `model` the helper printed, as a `RunUsage`; undefined when it printed none. */
function parseUsage(usage: unknown, model: unknown): RunUsage | undefined {
  if (!usage || typeof usage !== 'object') return undefined
  const u = usage as Record<string, unknown>
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0)
  return {
    ...(typeof model === 'string' && model ? { model } : {}),
    inputTokens: n(u['input']),
    outputTokens: n(u['output']),
    cacheWriteTokens: n(u['cacheWrite']),
    cacheReadTokens: n(u['cacheRead'])
  }
}

/** The helper's answer is its last JSON line; anything printed before it is ignored. */
export function parseOneshotOutput(stdout: string): OneshotOutcome | null {
  const lines = stdout.split('\n').reverse()
  for (const line of lines) {
    const start = line.indexOf('{"ok"')
    if (start < 0) continue
    try {
      const raw = JSON.parse(line.slice(start)) as Record<string, unknown>
      const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
      const usage = parseUsage(raw['usage'], raw['model'])
      return {
        ok: raw['ok'] === true,
        result: typeof raw['result'] === 'string' ? raw['result'] : '',
        ...(typeof raw['errorMessage'] === 'string' ? { errorMessage: raw['errorMessage'] } : {}),
        rateLimited: raw['rateLimited'] === true,
        ...(typeof raw['resetsAt'] === 'string' ? { resetsAt: raw['resetsAt'] } : {}),
        ...(typeof raw['costUsd'] === 'number' ? { costUsd: raw['costUsd'] } : {}),
        ...(usage ? { usage } : {}),
        ...(raw['readMode'] === 'light' || raw['readMode'] === 'full' || raw['readMode'] === 'bare' ? { readMode: raw['readMode'] } : {}),
        slackTools: strings(raw['slackTools']),
        deniedTools: strings(raw['deniedTools'])
      }
    } catch {
      // Not the outcome line; keep looking.
    }
  }
  return null
}

/** The read result for an outcome: failures by kind, else the parsed digest. */
export function toReadResult(outcome: OneshotOutcome | null): ChatReadResult {
  if (!outcome) return { ok: false, failure: 'failed', error: 'The Slack helper returned no answer.', deniedTools: [] }
  const base = {
    deniedTools: outcome.deniedTools,
    ...(outcome.costUsd !== undefined ? { costUsd: outcome.costUsd } : {}),
    ...(outcome.usage ? { usage: outcome.usage } : {}),
    ...(outcome.readMode === 'light' || outcome.readMode === 'full' ? { readMode: outcome.readMode } : {})
  }
  if (!outcome.ok) {
    const resetsAt = outcome.resetsAt ? Date.parse(outcome.resetsAt) : NaN
    return {
      ...base,
      ok: false,
      failure: outcome.rateLimited ? 'rateLimited' : 'failed',
      error: outcome.errorMessage ?? 'The query failed.',
      ...(Number.isFinite(resetsAt) ? { resetsAt } : {})
    }
  }
  if (!outcome.slackTools.length) return { ...base, ok: false, failure: 'noConnector', error: 'This Claude account has no Slack connector. Connect Slack in claude.ai for it.' }
  const digest = parseDigest(outcome.result)
  if (!digest) return { ...base, ok: false, failure: 'invalidAnswer', error: 'The answer was not valid JSON.' }
  return { ...base, ok: true, digest }
}

/** Where and how `oneshot.mjs` runs. */
export type OneshotRunOptions = Pick<SlackAgentSourceOptions, 'bridgeDir' | 'script' | 'nodeCommand'>

/**
 * Runs `oneshot.mjs` once with one request line and resolves with everything it printed on stdout
 * (the caller parses it with `parseOneshotOutput`). The process is killed after `killAfterMs`, a
 * last resort past the helper's own timeout, or as soon as `signal` aborts. Never rejects.
 */
export function runOneshot(options: OneshotRunOptions, line: string, killAfterMs: number, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve('')
    const child = spawn(options.nodeCommand ?? process.execPath, [join(options.bridgeDir, options.script ?? 'oneshot.mjs')], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true
    })
    let out = ''
    const timer = setTimeout(() => child.kill(), killAfterMs)
    const abort = () => child.kill()
    signal?.addEventListener('abort', abort, { once: true })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => (out += chunk))
    child.on('error', () => resolve(out))
    child.on('close', () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      resolve(out)
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end(line + '\n')
  })
}

/**
 * Reads Slack without a Slack app or token: one short headless Claude query per cycle (Haiku by
 * default) on the Slack connector of the chosen Claude account. The query has no built-in tools
 * and an allowlist of read-only Slack tools, enforced inside `oneshot.mjs`; any other tool is
 * denied and reported in `deniedTools`. It never posts.
 */
export class SlackAgentChatSource implements ChatSource {
  readonly provider = 'slack'

  constructor(private readonly options: SlackAgentSourceOptions) {}

  async read(request: ChatReadRequest): Promise<ChatReadResult> {
    const line = JSON.stringify({
      prompt: watchPrompt(request.channels, request.cursors, request.threads, request.now, request.prompts),
      cwd: this.options.cwd,
      model: request.model || 'haiku',
      maxTurns: 8,
      timeoutSeconds: this.options.timeoutSeconds ?? 300,
      ...(request.configDir ? { configDir: request.configDir } : {})
    })
    return toReadResult(parseOneshotOutput(await this.run(line)))
  }

  private run(line: string): Promise<string> {
    return runOneshot(this.options, line, ((this.options.timeoutSeconds ?? 300) + 30) * 1000)
  }
}
