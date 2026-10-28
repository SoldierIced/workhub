import type { slashCommandsEn } from './slashCommands.en'

/** Spanish copy of the composer's slash command menu and the commands Workhub runs itself. */
export const slashCommandsEs: Record<keyof typeof slashCommandsEn, string> = {
  'slash.menu': 'Comandos',
  'slash.group.workhub': 'Workhub',
  'slash.group.agent': '{agent}',
  'slash.group.skill': 'Skills y comandos propios',
  'slash.rename.description': 'Renombra esta sesión en la barra lateral, su ventana y el Historial',
  'slash.rename.hint': '<nombre>',
  'slash.rename.usage': 'Uso: /rename <nombre>',
  'slash.rename.done': 'La sesión ahora se llama “{name}”',
  'slash.rename.failed': 'No se pudo renombrar la sesión: {message}',
  'slash.model.description': 'Cambia el modelo de esta sesión',
  'slash.model.hint': '<modelo>',
  'slash.model.usage': 'Uso: /model <modelo>. Modelos: {models}',
  'slash.model.unknown': 'No hay un modelo “{model}”. Modelos: {models}',
  'slash.model.done': 'Ahora usa {model}',
  'slash.model.failed': 'No se pudo cambiar el modelo: {message}',
  'chat.noticeCleared': 'Se limpió la conversación.'
}
