/** English copy of session continuity: account failover, hand-off to another agent and their settings. */
export const continuityEn = {
  'continuity.menu': 'Continue elsewhere',
  'continuity.menu.loading': 'Loading…',
  'continuity.menu.accounts': 'Continue in another account',
  'continuity.menu.accountsHint': 'Same conversation: the transcript is copied to the other account and resumed there.',
  'continuity.menu.noAccounts': 'No other Claude account in this profile is under its ceiling.',
  'continuity.menu.handoff': 'Hand off to…',
  'continuity.menu.handoffHint': 'A new session of that agent in this folder, with a summary drafted in its composer. The other agent gets a summary, not the conversation.',
  'continuity.menu.noHandoff': 'No other agent with a chat is offered in this profile.',
  'continuity.menu.summarize': 'Ask the agent to summarize (uses one turn of this account)',
  'continuity.menu.busy': 'Wait for the turn to end, or interrupt it, before moving the session.',

  'continuity.offer.limit': '{account} reached its usage limit.',
  'continuity.offer.limitWindow': '{account} reached its {window} limit.',
  'continuity.offer.ceiling': '{account} is past your ceiling.',
  'continuity.offer.resets': 'It resets in {time}.',
  'continuity.offer.continueIn': 'Continue in {account}',
  'continuity.offer.handOffTo': 'Hand off to {agent}',
  'continuity.offer.wait': 'Wait',

  'continuity.origin.failover': 'Continued in {account}: {from} reached its {window} limit.',
  'continuity.origin.failoverNoWindow': 'Continued in {account}: {from} reached its usage limit.',
  'continuity.origin.failoverCeiling': 'Continued in {account}: {from} is past your {window} ceiling.',
  'continuity.origin.failoverCeilingNoWindow': 'Continued in {account}: {from} is past your ceiling.',
  'continuity.origin.failoverManual': 'Continued in {account} (moved from {from}).',
  'continuity.origin.handoff': 'Handed off from {from}. The brief below is a summary of that session, not its conversation.',
  'continuity.origin.review': 'Reviewer of {from}: a read-only session that reviews the change below and edits nothing.',

  'continuity.toast.moved': 'Continued in {account}.',
  'continuity.toast.handedOff': 'Hand-off to {agent} drafted. Review the brief, then send it.',
  'continuity.toast.summaryFailed': 'The agent could not write the summary; Workhub built the brief from the transcript instead.',
  'continuity.toast.failed': 'Could not continue the session: {message}',
  'continuity.notify.title': 'Usage limit: {account}',
  'continuity.notify.body': 'Continue in another account, hand the session off, or wait.',

  'continuity.settings.legend': 'When a Claude account runs out',
  'continuity.settings.mode': 'Account failover',
  'continuity.settings.ask': 'Ask',
  'continuity.settings.automatic': 'Automatic',
  'continuity.settings.off': 'Off',
  'continuity.settings.hint':
    'When a Claude account reaches its usage limit, or your ceiling in Settings → Usage, its session can continue in the next Claude account of this profile (in the agent order) that is under its ceilings. Ask offers it in the chat; Automatic switches by itself and tells Claude to go on. The conversation moves whole: its files are copied to the other account, never moved or overwritten.'
} as const
