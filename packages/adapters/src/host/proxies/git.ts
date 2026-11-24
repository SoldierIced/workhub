// GitRunner over the host: `git.run` runs git where the repositories live.
import { z } from 'zod'
import type { GitResult, GitRunner } from '../../git-review'
import type { HostClient } from '../client'
import type { HostHandlers } from '../server'
import { parseParams, parseResult } from './shared'

/** What the app adds to a git call's own timeout before it stops waiting for the host. */
const GIT_RPC_MARGIN_MS = 5_000
const GIT_DEFAULT_TIMEOUT_MS = 30_000

const gitRunParams = z.object({
  cwd: z.string().min(1),
  args: z.array(z.string()),
  opts: z.object({ maxBuffer: z.number().int().positive().optional(), timeoutMs: z.number().int().positive().optional() }).optional()
})

const gitResult = z.object({ ok: z.boolean(), stdout: z.string(), stderr: z.string(), timedOut: z.boolean().optional() })

/** Host side: answers `git.run` with a real runner. */
export function gitRunnerHandlers(run: GitRunner): HostHandlers {
  return {
    'git.run': async (params) => {
      const { cwd, args, opts } = parseParams(gitRunParams, params, 'git.run')
      return gitResult.parse(await run(cwd, args, opts))
    }
  }
}

/**
 * App side: a GitRunner that runs on the host. Like the local runner it never rejects: a host
 * error, a lost host or a malformed answer is a failed command with the reason in `stderr`. Its
 * output still has to fit on one protocol line (HOST_MAX_LINE_BYTES), whatever `maxBuffer` says.
 */
export function remoteGitRunner(client: HostClient): GitRunner {
  return async (cwd, args, opts) => {
    const timeoutMs = (opts?.timeoutMs ?? GIT_DEFAULT_TIMEOUT_MS) + GIT_RPC_MARGIN_MS
    try {
      const result = await client.request('git.run', { cwd, args, ...(opts ? { opts } : {}) }, { timeoutMs })
      return parseResult<GitResult>(gitResult, result, 'git.run')
    } catch (err) {
      return { ok: false, stdout: '', stderr: err instanceof Error ? err.message : String(err) }
    }
  }
}
