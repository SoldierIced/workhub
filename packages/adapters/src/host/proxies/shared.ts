// Helpers shared by the port proxies: each port has a host side (`*Handlers`, answering requests
// with a real implementation) and an app side (`remote*` / `connectRemote*`, the same port over a
// HostClient). Payloads are plain JSON; both sides validate what crosses the wire.
import { z } from 'zod'
import { HostRequestError } from '../client'
import { HostHandlerError } from '../server'

/** Sends an event from the host side (HostServer.emit). */
export type HostEmit = (event: string, payload?: unknown) => boolean

/**
 * A request timeout that never fires on its own (the largest delay setTimeout takes): for calls
 * that run as long as the work does (a prompt turn), where the host's own runtime owns timeouts and
 * the channel closing is what ends the wait.
 */
export const UNBOUNDED_TIMEOUT_MS = 2_147_483_647

function describeIssue(error: z.ZodError): string {
  const issue = error.issues[0]
  if (!issue) return 'invalid'
  return issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message
}

/** Host side: the params of `method`, or a `bad_params` error the app sees. */
export function parseParams<T>(schema: z.ZodType<T>, params: unknown, method: string): T {
  const parsed = schema.safeParse(params)
  if (!parsed.success) throw new HostHandlerError('bad_params', `${method}: bad params (${describeIssue(parsed.error)})`)
  return parsed.data
}

/** App side: the result of `method`, or an `internal` error when the host sent something else. */
export function parseResult<T>(schema: z.ZodType<T>, result: unknown, method: string): T {
  const parsed = schema.safeParse(result)
  if (!parsed.success) throw new HostRequestError('internal', `${method}: malformed result from the host (${describeIssue(parsed.error)})`)
  return parsed.data
}

/** A JSON object whose known fields are checked and whose other fields pass through untouched. */
export const objectLike = <T>() => z.custom<T>((v) => typeof v === 'object' && v !== null && !Array.isArray(v), 'expected an object')
