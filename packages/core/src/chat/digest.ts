import { fillPrompt, promptTemplate } from '../prompts/registry'
import type { PromptOverrides } from '../prompts/types'
import { msToTs, plainLinks, pullRequestsIn, ticketsIn } from './links'
import type { ChatDigest, ChatMessage, ChatReply, TrackedThread, WatchedChannel } from './types'

const TEXT_LIMIT = 1500

function str(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

const text = (value: unknown): string => plainLinks(typeof value === 'string' ? value : '').slice(0, TEXT_LIMIT)
const list = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)) : []

/** A message with its PR links and ticket keys read from the text. */
export function chatMessage(fields: Omit<ChatMessage, 'prUrls' | 'tickets'>): ChatMessage {
  return { ...fields, prUrls: pullRequestsIn(fields.text), tickets: ticketsIn(fields.text) }
}

/**
 * The agent's JSON answer, read leniently: code fences, prose around it and numbers where
 * strings belong are all accepted. Null when there is no object with `channels` or `threads`.
 */
export function parseDigest(answer: string): ChatDigest | null {
  const open = answer.indexOf('{')
  const close = answer.lastIndexOf('}')
  if (open < 0 || close <= open) return null
  let root: unknown
  try {
    root = JSON.parse(answer.slice(open, close + 1))
  } catch {
    return null
  }
  if (typeof root !== 'object' || root === null || Array.isArray(root)) return null
  const r = root as Record<string, unknown>
  if (!('channels' in r) && !('threads' in r)) return null
  const channels = list(r['channels'])
    .map((entry) => {
      const id = str(entry['id'])
      const messages = list(entry['messages']).flatMap((raw): ChatMessage[] => {
        const ts = str(raw['ts'])
        if (!id || !ts) return []
        const thread = str(raw['threadTs'] ?? raw['thread_ts'])
        const permalink = str(raw['permalink'])
        const replyText = str(raw['replyCount'] ?? raw['reply_count'])
        const replies = replyText ? Number(replyText) : NaN
        return [
          chatMessage({
            channelId: id,
            ts,
            ...(thread ? { threadTs: thread } : {}),
            user: str(raw['user']),
            text: text(raw['text']),
            ...(permalink ? { permalink } : {}),
            ...(Number.isFinite(replies) ? { replyCount: replies } : {})
          })
        ]
      })
      return { id, messages }
    })
    .filter((c) => c.id)
  const threads = list(r['threads'])
    .map((entry) => ({
      channelId: str(entry['channelId'] ?? entry['channel_id']),
      ts: str(entry['ts']),
      replies: list(entry['replies']).flatMap((raw): ChatReply[] => {
        const ts = str(raw['ts'])
        return ts ? [{ ts, user: str(raw['user']), text: text(raw['text']) }] : []
      })
    }))
    .filter((t) => t.channelId && t.ts)
  return { channels, threads, me: str(r['me']) }
}

/** Whether a message is a reply inside a thread rather than a top-level message. */
export function isReply(m: Pick<ChatMessage, 'ts' | 'threadTs'>): boolean {
  return Boolean(m.threadTs) && m.threadTs !== m.ts
}

/** How many open threads one read asks about at most. */
export const THREADS_PER_READ = 20

/**
 * The read-only prompt of one watcher cycle (Workhub 1's wording): new top-level messages per
 * channel after its cursor, new replies per open thread, answered as strict JSON.
 */
export function watchPrompt(
  channels: readonly WatchedChannel[],
  cursors: Readonly<Record<string, string>>,
  threads: readonly Pick<TrackedThread, 'channelId' | 'ts' | 'lastSeenReplyTs'>[],
  now: number,
  overrides?: PromptOverrides
): string {
  // The read-only line and the JSON answer format (the digest parser's) are fixed; the channel and
  // thread lists, with their headings, go where the text puts its slots.
  const channelLines = ['Channels: for each, list top-level messages posted after its ts (at most 30, oldest first).']
  for (const c of channels) {
    const cursor = cursors[c.id] ?? msToTs(now - 86_400_000)
    channelLines.push(`- ${c.id} #${c.name}${c.purpose ? ` (${c.purpose})` : ''}: after ${cursor}`)
  }
  const threadLines: string[] = []
  if (threads.length) {
    threadLines.push('Threads: for each, list replies after its ts (not the root message).')
    for (const t of threads) threadLines.push(`- channel ${t.channelId} thread ${t.ts}: after ${t.lastSeenReplyTs}`)
  }
  const values = { channels: channelLines.join('\n'), threads: threadLines.join('\n') }
  // No threads: a line holding only {threads} goes, as it never was a line.
  const template = promptTemplate(overrides, 'chat.slackWatch')
    .split('\n')
    .filter((line) => threadLines.length > 0 || line.trim() !== '{threads}')
    .join('\n')
  return [
    'Read-only Slack check. Use ONLY Slack read tools (read channel history, read thread, search); never send, react, draft or schedule anything.',
    fillPrompt(template, values),
    'Answer with STRICT JSON only, no prose and no code fence, using [] where nothing is new:',
    '{"channels":[{"id":"","messages":[{"ts":"","threadTs":"","user":"","text":"","permalink":"","replyCount":0}]}],' +
      '"threads":[{"channelId":"","ts":"","replies":[{"ts":"","user":"","text":""}]}],"me":""}'
  ].join('\n')
}
