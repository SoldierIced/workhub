// SessionHistorySources over the host: past sessions are listed and read where the agents keep them.
import { z } from 'zod'
import type { HistoryEntry, HistoryListOptions, HistoryMessage, HistoryMessagesOptions, SessionHistorySource } from '@workhub/core'
import type { HostClient } from '../client'
import { HostHandlerError, type HostHandlers } from '../server'
import { joinChunks, ResultChunks, type ResultChunksOptions } from './chunks'
import { objectLike, parseParams, parseResult } from './shared'

type HistoryAccount = Parameters<SessionHistorySource['list']>[0]

const account = z.looseObject({ agentId: z.string(), accountId: z.string().nullable(), configDir: z.string().optional() })
const listParams = z.object({ source: z.string(), account, options: z.looseObject({ limit: z.number().int().positive().optional() }).optional() })
const sessionIdsParams = z.object({ source: z.string(), account })
const messagesParams = z.object({
  source: z.string(),
  agentSessionId: z.string().min(1),
  cwd: z.string(),
  configDir: z.string().optional(),
  options: z.looseObject({ last: z.number().int().positive().optional() }).optional()
})
const renameParams = z.object({ source: z.string(), agentSessionId: z.string().min(1), cwd: z.string(), title: z.string(), configDir: z.string().optional() })

const describeResult = z.record(z.string(), z.object({ sessionIds: z.boolean(), rename: z.boolean() }))
const entriesResult = z.array(objectLike<HistoryEntry>())
const messagesResult = z.array(objectLike<HistoryMessage>())
const idsResult = z.array(z.string())

/** Where the rest of a long session's messages is asked for (see chunks.ts). */
export const HISTORY_NEXT_METHOD = 'history.next'

/**
 * Host side: `history.*` for these sources, keyed like SessionManager's `history` (agent id). A
 * session's messages larger than a line go in pieces (`history.next`).
 */
export function historySourceHandlers(sources: Partial<Record<string, SessionHistorySource>>, chunkOptions?: ResultChunksOptions): HostHandlers {
  const chunks = new ResultChunks(HISTORY_NEXT_METHOD, chunkOptions)
  const pick = (id: string, method: string): SessionHistorySource => {
    const source = Object.hasOwn(sources, id) ? sources[id] : undefined
    if (!source) throw new HostHandlerError('bad_params', `${method}: no history source "${id}"`)
    return source
  }
  return {
    'history.describe': () =>
      Object.fromEntries(
        Object.entries(sources).flatMap(([id, s]) => (s ? [[id, { sessionIds: typeof s.sessionIds === 'function', rename: typeof s.rename === 'function' }]] : []))
      ),
    'history.list': async (params) => {
      const p = parseParams(listParams, params, 'history.list')
      return pick(p.source, 'history.list').list(p.account as HistoryAccount, p.options)
    },
    'history.sessionIds': async (params) => {
      const p = parseParams(sessionIdsParams, params, 'history.sessionIds')
      const source = pick(p.source, 'history.sessionIds')
      if (!source.sessionIds) throw new HostHandlerError('bad_params', `history.sessionIds: source "${p.source}" cannot list ids`)
      return [...(await source.sessionIds(p.account as HistoryAccount))]
    },
    'history.messages': async (params) => {
      const p = parseParams(messagesParams, params, 'history.messages')
      return chunks.wrap(await pick(p.source, 'history.messages').messages(p.agentSessionId, p.cwd, p.configDir, p.options))
    },
    ...chunks.handlers,
    'history.rename': async (params) => {
      const p = parseParams(renameParams, params, 'history.rename')
      const source = pick(p.source, 'history.rename')
      if (!source.rename) throw new HostHandlerError('bad_params', `history.rename: source "${p.source}" cannot rename`)
      await source.rename(p.agentSessionId, p.cwd, p.title, p.configDir)
      return null
    }
  }
}

export interface RemoteHistoryOptions {
  /** Request timeout (a first listing reads every session file of the account). */
  timeoutMs?: number
}

function remoteSource(client: HostClient, id: string, has: { sessionIds: boolean; rename: boolean }, options: RemoteHistoryOptions): SessionHistorySource {
  const call = (method: string, params: Record<string, unknown>) => client.request(method, { source: id, ...params }, { timeoutMs: options.timeoutMs })
  const source: SessionHistorySource = {
    list: async (account: HistoryAccount, opts?: HistoryListOptions) =>
      parseResult(entriesResult, await call('history.list', { account, ...(opts ? { options: opts } : {}) }), 'history.list'),
    messages: async (agentSessionId: string, cwd: string, configDir?: string, opts?: HistoryMessagesOptions) => {
      const answer = await call('history.messages', { agentSessionId, cwd, configDir, ...(opts ? { options: opts } : {}) })
      return parseResult(messagesResult, await joinChunks(client, answer, 'history.messages', HISTORY_NEXT_METHOD, options.timeoutMs), 'history.messages')
    }
  }
  // The optional methods exist only when the host's source has them: callers test for them.
  if (has.sessionIds) {
    source.sessionIds = async (account) => new Set(parseResult(idsResult, await call('history.sessionIds', { account }), 'history.sessionIds'))
  }
  if (has.rename) {
    source.rename = async (agentSessionId, cwd, title, configDir) => {
      await call('history.rename', { agentSessionId, cwd, title, configDir })
    }
  }
  return source
}

/** App side: the host's history sources, keyed by the same ids. */
export async function connectRemoteHistorySources(client: HostClient, options: RemoteHistoryOptions = {}): Promise<Record<string, SessionHistorySource>> {
  const described = parseResult(describeResult, await client.request('history.describe'), 'history.describe')
  return Object.fromEntries(Object.entries(described).map(([id, has]) => [id, remoteSource(client, id, has, options)]))
}
