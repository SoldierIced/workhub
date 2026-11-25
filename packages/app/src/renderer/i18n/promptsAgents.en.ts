/**
 * English names of the editable prompts of this area (Settings → Prompts): per prompt id,
 * `prompts.<id>.name` (required), `prompts.<id>.when` (when it is sent) and `prompts.<id>.fixed`
 * (what Workhub always adds around it; only when there is something).
 */
export const promptsAgentsEn = {
  'prompts.continuity.summaryAsk.name': 'Ask the agent to summarize',
  'prompts.continuity.summaryAsk.when': 'When you hand a session off to another agent and choose to have the first agent write the summary.',
  'prompts.continuity.handoffIntro.name': 'Hand-off brief: introduction',
  'prompts.continuity.handoffIntro.when': 'At the start of the brief drafted for the agent that takes over a session.',
  'prompts.continuity.handoffIntro.fixed': 'The "Hand-off from" title, the goal, links, repository state, files, commands, open TODOs and the last exchanges.',
  'prompts.continuity.handoffNextStep.name': 'Hand-off brief: next step',
  'prompts.continuity.handoffNextStep.when': 'At the end of the brief drafted for the agent that takes over a session.',
  'prompts.continuity.handoffNextStep.fixed': 'The rest of the brief; the brief keeps its size limit, so a very long text is cut.',
  'prompts.continuity.continueAfterLimit.name': 'Continue after a usage limit',
  'prompts.continuity.continueAfterLimit.when': 'When a session moves to another account after its usage limit and keeps going.',
  'prompts.listen.system.name': 'Listen: how to summarize',
  'prompts.listen.system.when': 'Every time a long message is summarized to be read aloud.',
  'prompts.listen.system.fixed': 'The summary is cleaned of Markdown before it is read aloud.',
  'prompts.listen.user.name': 'Listen: the request',
  'prompts.listen.user.when': 'Every time a long message is summarized to be read aloud.',
  'prompts.listen.user.fixed': 'The message itself, between message tags, and a note when it was cut for length.',
  'prompts.chat.slackWatch.name': 'Slack watcher: what to read',
  'prompts.chat.slackWatch.when': 'Each time the Slack watcher checks your channels and followed threads.',
  'prompts.chat.slackWatch.fixed': 'The read-only rule (no posting, no reacting), the headings of the channel and thread lists, and the JSON answer format Workhub reads.',
  'prompts.chat.slackWake.name': 'Slack reply: message to the session',
  'prompts.chat.slackWake.when': 'When a reply arrives in a Slack thread that a session follows, and Workhub types it into that session.',
  'prompts.chat.slackWake.fixed': 'A note that the title and replies are untrusted content, and the thread title and replies, fenced.',
  'prompts.sessions.messageWrap.name': 'Message from another session',
  'prompts.sessions.messageWrap.when': 'When a session sends a message to another session and you approved it.',
  'prompts.sessions.messageWrap.fixed': 'A note that the text is data and not your instructions, and the message itself, fenced.',
  'prompts.sessions.localReviewIntro.name': 'Local review: comments heading',
  'prompts.sessions.localReviewIntro.when': 'When you send your review comments on a session\'s changes, once per repository.',
  'prompts.sessions.localReviewIntro.fixed': 'The comments, numbered, with their file and line.',
  'prompts.sessions.localReviewLooksGood.name': 'Local review: looks good',
  'prompts.sessions.localReviewLooksGood.when': 'When you press Looks good in the local review and choose to tell the session.'
} as const
