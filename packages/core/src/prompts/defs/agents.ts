import type { PromptDefinition } from '../types'

/** The editable prompts of continuity, Listen, the chat watcher and messages between sessions. */
export const AGENT_PROMPTS = {
  'continuity.summaryAsk': {
    area: 'continuity',
    placeholders: [],
    defaultText: [
      'Another coding agent is taking over this session. Without using any tools, write a hand-off summary of this conversation for it, in Markdown, with exactly these sections:',
      '## Goal — what the user wants, in one or two sentences.',
      '## Current state — what is done and what is not, as of now.',
      '## Decisions — choices made and why (libraries, approaches, things ruled out).',
      '## Files touched — paths, one line each on what changed.',
      '## Commands — the commands that matter to rebuild, test or run it.',
      '## Open TODOs — what is left, in order.',
      '## Next step — the very next thing to do.',
      'Reply with the summary only, no preamble. Keep it under 800 words.'
    ].join('\n')
  },
  'continuity.handoffIntro': {
    area: 'continuity',
    placeholders: ['source', 'cwd'],
    defaultText:
      'You are taking over a coding session that {source} worked on in {cwd}. This is a summary of that session, not its full conversation: check the repository before acting, and ask me when something is unclear.'
  },
  'continuity.handoffNextStep': {
    area: 'continuity',
    placeholders: [],
    defaultText: 'Read the repository state above, then continue from where the session left off. Tell me what you plan to do before large changes.'
  },
  'continuity.continueAfterLimit': {
    area: 'continuity',
    placeholders: [],
    defaultText: 'The previous account ran out of usage before you could finish. Continue where you left off.'
  },
  'listen.system': {
    area: 'listen',
    placeholders: [],
    defaultText: [
      'You rewrite a message from a coding agent so it can be listened to instead of read.',
      'Answer with the spoken summary only: plain prose of two to six short sentences.',
      'No Markdown, no lists, no headings, no code, no URLs, no file paths spelled out, no emoji.',
      'Name files, commands or code only in words when they matter, and keep numbers that matter.',
      'Write in the same language as the message. Do not add greetings, opinions or anything the message does not say.'
    ].join(' ')
  },
  'listen.user': {
    area: 'listen',
    placeholders: ['message'],
    slots: ['message'],
    defaultText: 'Summarize this message for listening.\n\n{message}'
  },
  'chat.slackWatch': {
    area: 'chat',
    placeholders: ['channels', 'threads'],
    slots: ['channels', 'threads'],
    defaultText: [
      'Copy message text verbatim (no summaries), truncated to 1500 characters. Slack timestamps (ts) are strings like 1712345678.123456.',
      '{channels}',
      '{threads}',
      'For "user", give the author\'s display name when the tool shows it, else their user ID.',
      'Set "me" to my Slack display name if you can read it cheaply, else "".'
    ].join('\n')
  },
  'chat.slackWake': {
    area: 'chat',
    placeholders: ['permalink', 'replies'],
    slots: ['replies'],
    defaultText: 'New reply in the tracked Slack thread ({permalink}). {replies}\nReview it and continue with what is needed.'
  },
  'sessions.messageWrap': {
    area: 'sessions',
    placeholders: ['from'],
    defaultText: 'Message from session {from} (another agent session in Workhub, not the user).'
  },
  'sessions.localReviewIntro': {
    area: 'sessions',
    placeholders: ['repo'],
    defaultText: 'Review comments on {repo}:'
  },
  'sessions.localReviewLooksGood': {
    area: 'sessions',
    placeholders: [],
    defaultText: 'Local review: looks good'
  }
} satisfies Record<string, PromptDefinition>
