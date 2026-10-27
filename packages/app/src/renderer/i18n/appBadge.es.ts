import type { appBadgeEn } from './appBadge.en'

/** Spanish copy of the app icon badge (Settings → General). */
export const appBadgeEs: Record<keyof typeof appBadgeEn, string> = {
  'settings.appBadge': 'Mostrar una insignia en el ícono de la app',
  'settings.appBadgeMac': 'El ícono del Dock muestra cuántas sesiones te necesitan: una respuesta sin leer, una pregunta o un error. Se borra al mirarlas.',
  'settings.appBadgeWindows': 'El botón de la barra de tareas muestra cuántas sesiones te necesitan: una respuesta sin leer, una pregunta o un error. Se borra al mirarlas.',
  'settings.appBadgeLinux': 'El ícono del lanzador muestra cuántas sesiones te necesitan (escritorios con insignias en el lanzador, como Unity o KDE). Se borra al mirarlas.'
}
