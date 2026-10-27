import type { settingsHelpEn } from './settingsHelp.en'

/** Spanish help texts of Settings (neutral). Same keys as `settingsHelpEn`. */
export const settingsHelpEs: Record<keyof typeof settingsHelpEn, string> = {
  'help.more': 'Más información',
  'help.about': 'Acerca de {name}',
  'help.appearance.base': 'El aspecto claro u oscuro de la app. Sistema sigue el de tu sistema operativo.',
  'help.appearance.theme': 'Los colores de las terminales de las sesiones. Elige Workhub para mantener los colores de la app, o activa "Usar el tema en toda la app" para colorear todo con él.',
  'help.appearance.terminalFont': 'La fuente de las terminales de las sesiones (Consola y Shell). Si la familia no está instalada, se usa la fuente monoespaciada predeterminada.',
  'help.appearance.text': 'Los tamaños de texto de esta instalación. Se guardan en esta computadora, no en la configuración compartida.'
}
