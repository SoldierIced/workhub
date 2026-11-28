import type { slashCommandsEn } from './slashCommands.en'

/** Spanish copy of the composer's slash command menu and the commands Workhub runs itself. */
export const slashCommandsEs: Record<keyof typeof slashCommandsEn, string> = {
  'slash.menu': 'Comandos',
  'slash.group.workhub': 'Workhub',
  'slash.group.agent': '{agent}',
  'slash.group.skill': 'Skills y comandos propios',
  'slash.login.description': 'Iniciá sesión en Claude: abre la vista Terminal y corre /login ahí',
  'slash.login.done': 'Iniciá sesión en la vista Terminal. Cuando termines, volvé a App (⌘⌥1 o Ctrl+Alt+1).',
  'slash.login.timeout': 'La vista Terminal no llegó a abrirse a tiempo. Escribí /login ahí.',
  'slash.login.failed': 'No se pudo abrir la vista Terminal para iniciar sesión: {message}',
  'slash.remoteControl.description': 'Activá Remote Control: abre la vista Terminal y corre /remote-control ahí',
  'slash.remoteControl.done':
    'Remote Control quedó activo en la vista Terminal. Sigue activo solo mientras la vista Terminal esté corriendo: volver a App lo termina, porque una sesión corre con un solo motor a la vez.',
  'slash.remoteControl.timeout': 'La vista Terminal no llegó a abrirse a tiempo. Escribí /remote-control ahí.',
  'slash.remoteControl.failed': 'No se pudo abrir la vista Terminal para activar Remote Control: {message}',
  'slash.terminal.badge': 'abre la Terminal',
  'slash.terminal.done': '{command} corrió en la vista Terminal. Volvé a App (⌘⌥1 o Ctrl+Alt+1) cuando termines.',
  'slash.terminal.timeout': 'La vista Terminal no llegó a abrirse a tiempo. Escribí {command} ahí.',
  'slash.terminal.failed': 'No se pudo abrir la vista Terminal para correr {command}: {message}',
  'slash.rename.description': 'Renombra esta sesión en la barra lateral, su ventana y el Historial',
  'slash.rename.hint': '<nombre>',
  'slash.rename.usage': 'Uso: /rename <nombre>',
  'slash.rename.done': 'La sesión ahora se llama “{name}”',
  'slash.rename.failed': 'No se pudo renombrar la sesión: {message}',
  'slash.cooking.description': 'Empezar un pedido con la skill workhub-cooking',
  'slash.cooking.hint': '<pedido>',
  'slash.cooking.usage': 'Uso: /cooking <pedido>',
  'slash.cooking.notInstalled': 'La skill workhub-cooking no está instalada para este agente. Instálala en Ajustes → Agentes → Herramientas de Workhub para agentes y abre una sesión nueva.',
  'slash.exit.description': 'Cierra esta sesión',
  'slash.model.description': 'Cambia el modelo de esta sesión',
  'slash.model.hint': '<modelo>',
  'slash.model.usage': 'Uso: /model <modelo>. Modelos: {models}',
  'slash.model.unknown': 'No hay un modelo “{model}”. Modelos: {models}',
  'slash.model.done': 'Ahora usa {model}',
  'slash.model.failed': 'No se pudo cambiar el modelo: {message}',
  'chat.noticeCleared': 'Se limpió la conversación.'
}
