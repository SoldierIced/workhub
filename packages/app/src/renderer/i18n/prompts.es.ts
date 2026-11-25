import type { promptsEn } from './prompts.en'

/** Spanish copy of Settings → Prompts (neutral). Same keys as `promptsEn`. */
export const promptsEs: Record<keyof typeof promptsEn, string> = {
  'settingsV2.nav.prompts': 'Prompts',
  'settingsV2.intro.prompts': 'Las instrucciones que Workhub les escribe a los agentes. Un texto editado se envía desde la próxima vez; lo que Workhub reúne, los formatos de respuesta que lee y sus notas de seguridad quedan como están.',
  'prompts.area.review': 'Revisión con IA',
  'prompts.area.continuity': 'Continuar en otro lado',
  'prompts.area.listen': 'Escuchar',
  'prompts.area.chat': 'Vigilante de chat',
  'prompts.area.sessions': 'Sesiones',
  'prompts.area.links': 'Pull requests y tickets',
  'prompts.area.health': 'Salud y mapas de flujo',
  'prompts.edited': 'Editado',
  'prompts.placeholders': 'Marcadores: {list}',
  'prompts.slots': 'Mantén {list}: ahí Workhub pone lo que reunió.',
  'prompts.unknown': 'Marcadores desconocidos: {list}. Con ellos este prompt no se puede guardar.',
  'prompts.missingSlots': 'Falta {list}: lo que Workhub reunió no llegaría al agente. Vuelve a ponerlo para guardar.',
  'prompts.missingOptional': 'Sin usar: {list}. Esa información no se enviará.',
  'prompts.fixed': 'Workhub siempre agrega: {what}',
  'prompts.restore': 'Restaurar el original',
  'prompts.restoreNamed': 'Restaurar el original de {name}',
  'prompts.cannotSave': 'Estos prompts todavía no se pueden guardar: {names}.',
  'prompts.none': 'No hay prompts para editar.',
  'prompts.elsewhere': 'Un perfil puede tener su propio brief de revisión (Perfiles → Pantallas → Revisión con IA); ese gana sobre el de acá. El brief de reuniones se edita por perfil en Perfiles → Pantallas → Plan. Un texto que dejes vacío vuelve a su original.'
}
