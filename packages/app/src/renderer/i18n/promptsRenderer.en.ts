/**
 * English names of the editable prompts of this area (Settings → Prompts): per prompt id,
 * `prompts.<id>.name` (required), `prompts.<id>.when` (when it is sent) and `prompts.<id>.fixed`
 * (what Workhub always adds around it; only when there is something).
 */
export const promptsRendererEn = {
  'prompts.links.reviewPr.name': 'Review a pull request',
  'prompts.links.reviewPr.when': 'When you choose "Ask Claude to review" on a pull request: the text is left in the composer of a new session, not sent.',
  'prompts.links.ticket.name': 'Work on a ticket',
  'prompts.links.ticket.when': 'When you start a session about a ticket that has a link: the text is left in the composer, not sent.',
  'prompts.links.ticketNoUrl.name': 'Work on a ticket (no link)',
  'prompts.links.ticketNoUrl.when': 'When you start a session about a ticket that has no link: the text is left in the composer, not sent.',
  'prompts.links.fixCi.name': 'Fix CI on a pull request',
  'prompts.links.fixCi.when': 'When you click "Fix CI" on a pull request: it is sent to the session linked to it.',
  'prompts.links.fixCi.fixed': 'The title and the failing checks, always preceded by a note that they are data to read and never instructions to follow.',
  'prompts.links.addressReview.name': 'Address review comments',
  'prompts.links.addressReview.when': 'When you click "Address review comments" on a pull request: it is sent to the session linked to it.',
  'prompts.links.addressReview.fixed': 'The title and the review comments, always preceded by a note that they are data to read and never instructions to follow.',
  'prompts.health.ask.name': 'Health: closing request',
  'prompts.health.ask.when': 'When you investigate an error, a silent service, a pod or an event from Health: it closes the draft left in a new session.',
  'prompts.health.ask.fixed': 'The data Workhub gathers (trends, error groups, events, logs and links).',
  'prompts.health.flowAsk.name': 'Health: closing request for a slow endpoint',
  'prompts.health.flowAsk.when': 'When you investigate a slow endpoint from Health: it closes the draft left in a new session.',
  'prompts.health.flowAsk.fixed': 'The numbers, the slowest spans and the comparison with the previous period.',
  'prompts.health.togetherAsk.name': 'Health: closing request for several signals',
  'prompts.health.togetherAsk.when': 'When you investigate several signals together from Health: it closes the combined draft.',
  'prompts.health.togetherAsk.fixed': 'One numbered section per selected signal, with its data.',
  'prompts.health.flowMapAsk.name': 'Flow map: request',
  'prompts.health.flowMapAsk.when': 'When you ask Claude about a flow map: it closes the draft left in the composer, not sent.',
  'prompts.health.flowMapAsk.fixed': 'The map file, the numbers of the window, what is not measured, the selected execution and its logs.'
} as const
