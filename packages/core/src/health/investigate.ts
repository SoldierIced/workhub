import type { SlowTransaction } from './types'

const round = (n: number) => (n >= 100 ? Math.round(n) : Math.round(n * 10) / 10)

/**
 * The prompt "Investigate with Claude" drafts for a slow endpoint. It is written into the
 * composer of a new session and never sent: the user reads it, edits it and sends it.
 */
export function investigateSlowEndpointPrompt(env: { name: string; slowFlowHours: number }, tx: SlowTransaction): string {
  const hours = env.slowFlowHours
  const lines = [
    `The endpoint "${tx.name}" of the service "${tx.service}" is slow in the ${env.name} environment.`,
    '',
    `Over the last ${hours} hours it had ${tx.calls} calls, p50 ${round(tx.p50Ms)} ms, p95 ${round(tx.p95Ms)} ms and p99 ${round(tx.p99Ms)} ms, with ${round(tx.failureRate * 100)}% failures.`,
    '',
    'Find the code behind this endpoint in this folder and look for why it is slow: queries or calls made in a loop, missing indexes or caches, work that could run in parallel or be deferred, and downstream calls without a timeout. Propose the smallest change that would help and say how to confirm it with the numbers above. Do not change anything until I agree.'
  ]
  return lines.join('\n')
}
