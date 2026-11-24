/** English copy of Settings → Prompts (the section; each prompt's own name is in promptsReview/Agents/Renderer). */
export const promptsEn = {
  'settingsV2.nav.prompts': 'Prompts',
  'settingsV2.intro.prompts': 'The instructions Workhub writes to agents. An edited text is sent from the next time; what Workhub gathers, the reply formats it reads and its safety notes stay as they are.',
  'prompts.area.review': 'AI review',
  'prompts.area.continuity': 'Continue elsewhere',
  'prompts.area.listen': 'Listen',
  'prompts.area.chat': 'Chat watcher',
  'prompts.area.sessions': 'Sessions',
  'prompts.area.links': 'Pull requests and tickets',
  'prompts.area.health': 'Health and flow maps',
  'prompts.edited': 'Edited',
  'prompts.placeholders': 'Placeholders: {list}',
  'prompts.slots': 'Keep {list}: Workhub puts what it gathered there.',
  'prompts.unknown': 'Unknown placeholders: {list}. This prompt cannot be saved with them.',
  'prompts.missingSlots': 'Missing {list}: what Workhub gathered would not reach the agent. Put it back to save.',
  'prompts.missingOptional': 'Not used: {list}. That information will not be sent.',
  'prompts.fixed': 'Workhub always adds: {what}',
  'prompts.restore': 'Restore default',
  'prompts.restoreNamed': 'Restore the default of {name}',
  'prompts.cannotSave': 'These prompts cannot be saved yet: {names}.',
  'prompts.none': 'No prompt to edit.',
  'prompts.elsewhere': 'A profile can keep its own review brief (Profiles → Screens → AI review); it wins over the one here. The meeting brief is edited per profile in Profiles → Screens → Plan. A text left blank goes back to its default.'
} as const
