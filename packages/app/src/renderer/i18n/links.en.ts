/** English copy of the session links: pull request / ticket to session, and the past sessions listed beside them. */
export const linksEn = {
  'links.pr.openSession': 'Open session',
  'links.pr.openSessionHint': 'Open the session linked to this pull request, or start one in the matching folder',
  'links.pr.review': 'Ask Claude to review',
  'links.pr.reviewHint': 'Start a Claude session with a review prompt in the composer; nothing is sent until you press Send',
  'links.ticket.start': 'Start session about this ticket',
  'links.ticket.startShort': 'Start a session about {key}',
  'links.pastSessions': 'Past sessions',
  'links.pastSessions.empty': 'No past sessions mention this.',
  'links.pastSessions.loading': 'Reading the session history…',
  'links.pastSessions.error': 'Could not read the session history: {message}',
  'links.reason.url': 'names the PR',
  'links.reason.branch': 'same branch',
  'links.reason.ticket': 'same ticket',
  'links.resume': 'Resume',
  'links.listedOnly': 'This agent cannot be resumed from Workhub',
  'links.opened': 'Opened the linked session',
  'links.started': 'Session started in {folder}',
  'links.drafted': 'Prompt drafted in the composer. Edit it if you like, then press Send.',
  'links.noClaude': 'Claude is not available in this profile, so there is no session to draft the prompt in.',
  'links.noAgent': 'This profile has no agent to start a session with.',
  'links.failed': 'Could not start the session: {message}',
  'links.prompt.review':
    'Review pull request {name} "{title}" ({url}).\n\nIt merges {branch} into {base} and was opened by {author}.\n\nRead its diff (with the host CLI, or git diff against {base}) and the code around it in this folder. Look for bugs, missing tests, unclear names and risky changes, and list what you would change, most important first. Do not change anything or post any comment until I agree.',
  'links.prompt.ticket':
    'I want to work on ticket {key}: "{title}".\n\nTicket link: {url}\n\nRead the ticket and the code it touches in this folder, and tell me how you would approach it and what you would check first. Do not change anything until I agree.',
  'links.prompt.ticketNoUrl':
    'I want to work on ticket {key}: "{title}".\n\nRead the ticket and the code it touches in this folder, and tell me how you would approach it and what you would check first. Do not change anything until I agree.'
} as const
