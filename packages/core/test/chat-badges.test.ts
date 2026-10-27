import { describe, expect, it } from 'vitest'
import { newThread, pullRequestSlackLinks, slackLinkSummary, threadsOfSession, type ChatMessage, type TrackedThread } from '../src'

const NOW = Date.UTC(2026, 9, 27, 12, 0, 0)
const PR = 'https://github.com/acme/web/pull/12'

function thread(fields: Partial<TrackedThread> = {}): TrackedThread {
  return newThread({ id: 'th1', channelId: 'C01', ts: '1761566400.000100', permalink: 'https://acme.slack.com/archives/C01/p1761566400000100', title: 'Review please', source: 'manual', createdAt: NOW, ...fields })
}

function message(fields: Partial<ChatMessage> = {}): ChatMessage {
  return { channelId: 'C01', ts: '1761566400.000100', user: 'ana', text: 'look', prUrls: [], tickets: [], ...fields }
}

describe('Slack badges', () => {
  it('collects the messages and threads that link a PR, whatever the URL spelling', () => {
    const messages = [message({ prUrls: ['https://github.com/Acme/web/pull/12'] }), message({ ts: '2', prUrls: ['https://github.com/acme/web/pull/13'] })]
    const threads = [
      thread({ id: 'a', prUrl: `${PR}/files` }),
      thread({ id: 'b', replies: [{ ts: '1761566500.000100', user: 'luis', text: `see <${PR}|#12>` }] }),
      thread({ id: 'c', prUrl: 'https://github.com/acme/web/pull/99' })
    ]
    const links = pullRequestSlackLinks(messages, threads, PR)
    expect(links.messages).toHaveLength(1)
    expect(links.threads.map((t) => t.id)).toEqual(['a', 'b'])
  })

  it('shows no badge without links and a dot only for unread replies of open threads', () => {
    expect(slackLinkSummary({ messages: [], threads: [] }, 'me')).toBeNull()
    const read = thread({ id: 'a', replies: [{ ts: '1761566500.000100', user: 'luis', text: 'ok' }], lastViewedReplyTs: '1761566500.000100' })
    expect(slackLinkSummary({ messages: [message()], threads: [read] }, 'me')).toEqual({ threads: 1, messages: 1, unread: false })
    const unread = thread({ id: 'b', replies: [{ ts: '1761566600.000100', user: 'luis', text: 'ping' }] })
    expect(slackLinkSummary({ messages: [], threads: [unread] }, 'me')?.unread).toBe(true)
    // The user's own reply is never unread, and a closed thread does not light the dot.
    expect(slackLinkSummary({ messages: [], threads: [thread({ replies: [{ ts: '1761566600.000100', user: 'me', text: 'done' }] })] }, 'me')?.unread).toBe(false)
    expect(slackLinkSummary({ messages: [], threads: [{ ...unread, closed: true }] }, 'me')?.unread).toBe(false)
  })

  it('lists the open threads a session owns', () => {
    const threads = [thread({ id: 'a', owner: 's1' }), thread({ id: 'b', owner: 's1', closed: true }), thread({ id: 'c', owner: 's2' }), thread({ id: 'd' })]
    expect(threadsOfSession(threads, 's1').map((t) => t.id)).toEqual(['a'])
  })
})
