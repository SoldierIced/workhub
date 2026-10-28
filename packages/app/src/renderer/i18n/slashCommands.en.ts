/** English copy of the composer's slash command menu and the commands Workhub runs itself. */
export const slashCommandsEn = {
  'slash.menu': 'Commands',
  'slash.group.workhub': 'Workhub',
  'slash.group.agent': '{agent}',
  'slash.group.skill': 'Skills and custom commands',
  'slash.rename.description': 'Rename this session in the sidebar, its window and History',
  'slash.rename.hint': '<name>',
  'slash.rename.usage': 'Usage: /rename <name>',
  'slash.rename.done': 'Renamed the session to “{name}”',
  'slash.rename.failed': 'Could not rename the session: {message}',
  'slash.model.description': 'Switch this session to another model',
  'slash.model.hint': '<model>',
  'slash.model.usage': 'Usage: /model <model>. Models: {models}',
  'slash.model.unknown': 'No model “{model}”. Models: {models}',
  'slash.model.done': 'Switched to {model}',
  'slash.model.failed': 'Could not switch the model: {message}',
  'chat.noticeCleared': 'The conversation was cleared.'
} as const
