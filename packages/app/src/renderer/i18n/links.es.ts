import type { linksEn } from './links.en'

/** Spanish copy for `links.en.ts`: same keys, same placeholders. */
export const linksEs: Record<keyof typeof linksEn, string> = {
  'links.pr.openSession': 'Abrir sesión',
  'links.pr.openSessionHint': 'Abre la sesión vinculada a este pull request, o inicia una en la carpeta que corresponde',
  'links.pr.review': 'Pedirle a Claude que revise',
  'links.pr.reviewHint': 'Inicia una sesión de Claude con un prompt de revisión en el compositor; no se envía nada hasta que pulses Enviar',
  'links.ticket.startShort': 'Iniciar una sesión sobre {key}',
  'links.pastSessions': 'Sesiones anteriores',
  'links.pastSessions.empty': 'Ninguna sesión anterior menciona esto.',
  'links.pastSessions.loading': 'Leyendo el historial de sesiones…',
  'links.pastSessions.error': 'No se pudo leer el historial de sesiones: {message}',
  'links.reason.url': 'nombra el PR',
  'links.reason.branch': 'misma rama',
  'links.reason.ticket': 'mismo ticket',
  'links.resume': 'Reanudar',
  'links.listedOnly': 'Este agente no se puede reanudar desde Workhub',
  'links.opened': 'Se abrió la sesión vinculada',
  'links.started': 'Sesión iniciada en {folder}',
  'links.drafted': 'Prompt redactado en el compositor. Edítalo si quieres y pulsa Enviar.',
  'links.noClaude': 'Claude no está disponible en este perfil, así que no hay sesión donde redactar el prompt.',
  'links.noAgent': 'Este perfil no tiene un agente con el que iniciar una sesión.',
  'links.failed': 'No se pudo iniciar la sesión: {message}',
  'links.prompt.review':
    'Revisa el pull request {name} "{title}" ({url}).\n\nIntegra {branch} en {base} y lo abrió {author}.\n\nLee su diff (con la CLI del host, o git diff contra {base}) y el código que lo rodea en esta carpeta. Busca errores, pruebas que faltan, nombres poco claros y cambios riesgosos, y lista lo que cambiarías, lo más importante primero. No cambies nada ni publiques ningún comentario hasta que yo esté de acuerdo.',
  'links.prompt.ticket':
    'Quiero trabajar en el ticket {key}: "{title}".\n\nEnlace del ticket: {url}\n\nLee el ticket y el código que toca en esta carpeta, y dime cómo lo abordarías y qué revisarías primero. No cambies nada hasta que yo esté de acuerdo.',
  'links.prompt.ticketNoUrl':
    'Quiero trabajar en el ticket {key}: "{title}".\n\nLee el ticket y el código que toca en esta carpeta, y dime cómo lo abordarías y qué revisarías primero. No cambies nada hasta que yo esté de acuerdo.'
}
