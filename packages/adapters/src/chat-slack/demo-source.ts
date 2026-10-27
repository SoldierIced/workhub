import { chatMessage, isAfter, msToTs, type ChatDigest, type ChatMessage, type ChatReadRequest, type ChatReadResult, type ChatReply, type ChatSource } from '@workhub/core'

/** A message to serve on the next read (demo mode). */
export interface DemoMessageInput {
  channelId: string
  user: string
  text: string
  /** Defaults to now. Reuse a ts to offer the same event again. */
  ts?: string
  threadTs?: string
  /** Serve it on the next read even when it is older than the channel's cursor (a duplicated event). */
  replay?: boolean
}

export interface DemoReplyInput {
  channelId: string
  threadTs: string
  user: string
  text: string
  ts?: string
}

const DEMO_HOST = 'demo-workspace.slack.com'

/**
 * Synthetic Slack for demos, screenshots and tests (`WORKHUB_DEMO_SLACK=1`): no agent query, no
 * network. Each watched channel starts with a few made-up messages; `inject` and `injectReply`
 * add more, served on the next read. Nothing here is real data.
 */
export class DemoChatSource implements ChatSource {
  readonly provider = 'slack-demo'
  private readonly messages: ChatMessage[] = []
  private readonly replays: ChatMessage[] = []
  private readonly replies: { channelId: string; threadTs: string; reply: ChatReply }[] = []
  private seededChannels = new Set<string>()
  private clock = 0

  constructor(private readonly now: () => number = Date.now) {}

  /** A unique ts after every one handed out so far. */
  private nextTs(): string {
    this.clock = Math.max(this.clock + 1, this.now())
    return msToTs(this.clock)
  }

  inject(input: DemoMessageInput): ChatMessage {
    const ts = input.ts ?? this.nextTs()
    const m = chatMessage({
      channelId: input.channelId,
      ts,
      user: input.user,
      text: input.text,
      permalink: `https://${DEMO_HOST}/archives/${input.channelId}/p${ts.replace('.', '')}`,
      ...(input.threadTs ? { threadTs: input.threadTs } : {})
    })
    if (input.replay) this.replays.push(m)
    else this.messages.push(m)
    return m
  }

  injectReply(input: DemoReplyInput): ChatReply {
    const reply = { ts: input.ts ?? this.nextTs(), user: input.user, text: input.text }
    this.replies.push({ channelId: input.channelId, threadTs: input.threadTs, reply })
    return reply
  }

  private seed(channelId: string, name: string): void {
    if (this.seededChannels.has(channelId)) return
    this.seededChannels.add(channelId)
    const base = this.now() - 3 * 3_600_000
    const samples = [
      { user: 'Ana (demo)', text: `Could someone review https://github.com/acme-demo/web/pull/101 ? It adds the export button. #${name}` },
      { user: 'Luis (demo)', text: 'Deploy of the API to staging is done, smoke tests are green.' },
      { user: 'Marta (demo)', text: 'PR for DEMO-42: https://github.com/acme-demo/api/pull/57, small fix in the retry logic.' }
    ]
    samples.forEach((s, i) => this.inject({ channelId, user: s.user, text: s.text, ts: msToTs(base + i * 1_800_000) }))
  }

  async read(request: ChatReadRequest): Promise<ChatReadResult> {
    for (const c of request.channels) this.seed(c.id, c.name)
    const digest: ChatDigest = {
      me: 'You (demo)',
      channels: request.channels.map((c) => ({
        id: c.id,
        messages: [
          ...this.messages.filter((m) => m.channelId === c.id && isAfter(m.ts, request.cursors[c.id])),
          ...this.replays.filter((m) => m.channelId === c.id)
        ]
      })),
      threads: request.threads.map((t) => ({
        channelId: t.channelId,
        ts: t.ts,
        replies: this.replies.filter((r) => r.channelId === t.channelId && r.threadTs === t.ts && isAfter(r.reply.ts, t.lastSeenReplyTs)).map((r) => r.reply)
      }))
    }
    this.replays.splice(0)
    return { ok: true, digest, costUsd: 0, deniedTools: [] }
  }
}
