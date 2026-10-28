import type { unsavedEn } from './unsaved.en'

/** Spanish copy of the save bar and the unsaved-changes prompt of forms that need an explicit save. */
export const unsavedEs: Record<keyof typeof unsavedEn, string> = {
  'unsaved.changes': 'Cambios sin guardar',
  'unsaved.save': 'Guardar',
  'unsaved.saving': 'Guardando…',
  'unsaved.discard': 'Descartar',
  'unsaved.saved': 'Guardado',
  'unsaved.couldNotSave': 'No se pudo guardar: corrige los problemas indicados arriba.',
  'unsaved.fixField': 'Corrige esto antes de guardar: {problem}',
  'unsaved.promptTitle': '¿Guardar los cambios?',
  'unsaved.promptBody': 'Este formulario tiene cambios sin guardar. Guárdalos, descártalos o cancela para seguir editando.',
  'unsaved.keepEditing': 'Cancelar',
  'unsaved.confirmDeleteTitle': '¿Eliminar {name}?',
  'unsaved.confirmDeleteBody': 'Esta acción no se puede deshacer.',
  'settings.idRequired': 'Ingresa un id.',
  'settings.defaultFolder': 'Carpeta predeterminada',
  'settings.defaultFolderHint': 'Donde "Nueva sesión" empieza sin preguntar: una de las carpetas de arriba u otra. Vacía: la primera carpeta.',
  'settings.defaultFolderFirst': 'Primera carpeta ({folder})',
  'settings.defaultFolderHome': 'Carpeta de inicio',
  'settings.defaultFolderOther': 'Otra carpeta…'
}
