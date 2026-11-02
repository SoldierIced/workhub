import type { updatesEn } from './updates.en'

/** Spanish copy of the update settings (P8). */
export const updatesEs: Record<keyof typeof updatesEn, string> = {
  'updates.group': 'Actualizaciones',
  'updates.check': 'Buscar actualizaciones',
  'updates.checkHint': 'Busca una versión más nueva en GitHub al abrir la app y cada 6 horas mientras está abierta, y pregunta como mucho una vez al día si quieres actualizar. Apagado por defecto: no se contacta nada salvo que lo pidas.',
  'updates.checkNow': 'Buscar ahora',
  'updates.checking': 'Buscando…',
  'updates.version': 'Esta es la versión {version}.',
  'updates.none': 'Tienes la última versión ({version}).',
  'updates.available': 'Hay una versión nueva: {version}.',
  'updates.downloading': 'Descargando e instalando la versión {version}…',
  'updates.install': 'Instalar actualización',
  'updates.download': 'Descargar la versión nueva',
  'updates.ready': 'La versión {version} está instalada. Se usa después de reiniciar.',
  'updates.restartNow': 'Reiniciar ahora',
  'updates.later': 'Más tarde',
  'updates.promptTitle': 'Hay una versión nueva',
  'updates.promptBody': 'Hay disponible Workhub {version} (tienes {current}). ¿Quieres actualizar ahora?',
  'updates.updateNow': 'Actualizar ahora',
  'updates.skipVersion': 'Omitir esta versión',
  'updates.readyTitle': 'Actualización instalada',
  'updates.readyBody': 'La versión {version} está instalada. Reinicia ahora o sigue trabajando: arranca la próxima vez que abras Workhub.',
  'updates.error': 'No se pudo buscar actualizaciones: {message}',
  'updates.unsupported': 'Las actualizaciones solo se buscan en la app instalada.',
  'updates.macNote': 'Si la app no puede escribir en su carpeta (por ejemplo, no está en Aplicaciones), descarga la versión nueva y reemplaza la app.'
}
