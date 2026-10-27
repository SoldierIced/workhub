import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { parseDigest, watchPrompt, type ChatReadRequest, type ChatReadResult, type ChatSource } from '@workhub/core'

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
  slackTools: string[]
  deniedTools: string[]
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
      return {
        ok: raw['ok'] === true,
        result: typeof raw['result'] === 'string' ? raw['result'] : '',
        ...(typeof raw['errorMessage'] === 'string' ? { errorMessage: raw['errorMessage'] } : {}),
        rateLimited: raw['rateLimited'] === true,
        ...(typeof raw['resetsAt'] === 'string' ? { resetsAt: raw['resetsAt'] } : {}),
        ...(typeof raw['costUsd'] === 'number' ? { costUsd: raw['costUsd'] } : {}),
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
  const base = { deniedTools: outcome.deniedTools, ...(outcome.costUsd !== undefined ? { costUsd: outcome.costUsd } : {}) }
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
      prompt: watchPrompt(request.channels, request.cursors, request.threads, request.now),
      cwd: this.options.cwd,
      model: request.model || 'haiku',
      maxTurns: 8,
      timeoutSeconds: this.options.timeoutSeconds ?? 300,
      ...(request.configDir ? { configDir: request.configDir } : {})
    })
    return toReadResult(parseOneshotOutput(await this.run(line)))
  }

  private run(line: string): Promise<string> {
    return new Promise((resolve) => {
      const child = spawn(this.options.nodeCommand ?? process.execPath, [join(this.options.bridgeDir, this.options.script ?? 'oneshot.mjs')], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true
      })
      let out = ''
      const timer = setTimeout(() => child.kill(), ((this.options.timeoutSeconds ?? 300) + 30) * 1000)
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => (out += chunk))
      child.on('error', () => resolve(out))
      child.on('close', () => {
        clearTimeout(timer)
        resolve(out)
      })
      child.stdin.end(line + '\n')
    })
  }
}
