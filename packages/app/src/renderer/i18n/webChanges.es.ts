import type { webChangesEn } from './webChanges.en'

/** Spanish copy of the phone's Changes screen (what a session changed) and its review loop card. */
export const webChangesEs: Record<keyof typeof webChangesEn, string> = {
  'web.changes.open': 'Cambios',
  'web.changes.title': 'Cambios',
  'web.changes.loading': 'Leyendo los cambios en la computadora…',
  'web.changes.failed': 'No se pudieron leer los cambios. Probá de nuevo, o abrilos en la computadora.',
  'web.changes.offline': 'La computadora no está disponible ahora.',
  'web.changes.refresh': 'Leer los cambios de nuevo',
  'web.changes.loadMore': 'Cargar más',
  'web.changes.retry': 'Reintentar',
  'web.changes.wrap': 'Ajustar las líneas largas',
  'web.changes.emptyHint': 'Pedile un cambio al agente, o cambiá el alcance de arriba.',
  'web.changes.against': 'contra {base}',
  'web.changes.files.one': '{count} archivo',
  'web.changes.files.other': '{count} archivos',
  'web.changes.hidden': 'No se muestra en el teléfono: los archivos ocultos y los nombres de claves quedan en la computadora.',
  'web.changes.diffFailed': 'No se pudo leer el diff: {error}',
  'web.changes.cutLines.one': 'Se recortó {count} línea larga; la computadora la muestra entera.',
  'web.changes.cutLines.other': 'Se recortaron {count} líneas largas; la computadora las muestra enteras.',
  'web.review.round': 'Ronda {n}',
  'web.review.failed': 'La decisión no llegó a la computadora: {error}',
  'web.review.omitted.one': 'Hay {count} hallazgo más en la computadora',
  'web.review.omitted.other': 'Hay {count} hallazgos más en la computadora'
}
