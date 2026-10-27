import type { updatesEn } from './updates.en'

/** Spanish copy of the update settings (P8). */
export const updatesEs: Record<keyof typeof updatesEn, string> = {
  'updates.group': 'Actualizaciones',
  'updates.check': 'Buscar actualizaciones',
  'updates.checkHint': 'Busca una versión nueva en GitHub al abrir la app. Desactivado por defecto: no se contacta a nadie si no lo pides.',
  'updates.checkNow': 'Buscar ahora',
  'updates.checking': 'Buscando…',
  'updates.version': 'Esta es la versión {version}.',
  'updates.none': 'Tienes la última versión ({version}).',
  'updates.available': 'Hay una versión nueva: {version}.',
  'updates.downloading': 'Descargando la versión {version}…',
  'updates.install': 'Descargar y reiniciar',
  'updates.download': 'Descargar la versión nueva',
  'updates.error': 'No se pudo buscar actualizaciones: {message}',
  'updates.unsupported': 'Las actualizaciones solo se buscan en la app instalada.',
  'updates.macNote': 'Esta versión no está firmada, así que macOS no puede instalar actualizaciones solo: descarga la versión nueva y reemplaza la app.'
}
