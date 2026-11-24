import type { promptsRendererEn } from './promptsRenderer.en'

/** Spanish names of the editable prompts of this area (neutral). Same keys as `promptsRendererEn`. */
export const promptsRendererEs: Record<keyof typeof promptsRendererEn, string> = {
  'prompts.links.reviewPr.name': 'Revisar un pull request',
  'prompts.links.reviewPr.when': 'Cuando eliges «Pedir a Claude que revise» en un pull request: el texto queda en el escritor de una sesión nueva, no se envía.',
  'prompts.links.ticket.name': 'Trabajar en un ticket',
  'prompts.links.ticket.when': 'Cuando inicias una sesión sobre un ticket que tiene enlace: el texto queda en el escritor, no se envía.',
  'prompts.links.ticketNoUrl.name': 'Trabajar en un ticket (sin enlace)',
  'prompts.links.ticketNoUrl.when': 'Cuando inicias una sesión sobre un ticket que no tiene enlace: el texto queda en el escritor, no se envía.',
  'prompts.links.fixCi.name': 'Arreglar el CI de un pull request',
  'prompts.links.fixCi.when': 'Cuando haces clic en «Arreglar CI» en un pull request: se envía a la sesión vinculada a él.',
  'prompts.links.fixCi.fixed': 'El título y los checks que fallan, siempre precedidos por una nota que dice que son datos para leer y nunca instrucciones que seguir.',
  'prompts.links.addressReview.name': 'Atender comentarios de revisión',
  'prompts.links.addressReview.when': 'Cuando haces clic en «Atender comentarios» en un pull request: se envía a la sesión vinculada a él.',
  'prompts.links.addressReview.fixed': 'El título y los comentarios de revisión, siempre precedidos por una nota que dice que son datos para leer y nunca instrucciones que seguir.',
  'prompts.health.ask.name': 'Salud: pedido final',
  'prompts.health.ask.when': 'Cuando investigas un error, un servicio en silencio, un pod o un evento desde Salud: cierra el borrador que queda en una sesión nueva.',
  'prompts.health.ask.fixed': 'Los datos que reúne Workhub (tendencias, grupos de error, eventos, logs y enlaces).',
  'prompts.health.flowAsk.name': 'Salud: pedido final para un endpoint lento',
  'prompts.health.flowAsk.when': 'Cuando investigas un endpoint lento desde Salud: cierra el borrador que queda en una sesión nueva.',
  'prompts.health.flowAsk.fixed': 'Los números, los spans más lentos y la comparación con el periodo anterior.',
  'prompts.health.togetherAsk.name': 'Salud: pedido final para varias señales',
  'prompts.health.togetherAsk.when': 'Cuando investigas varias señales juntas desde Salud: cierra el borrador combinado.',
  'prompts.health.togetherAsk.fixed': 'Una sección numerada por cada señal elegida, con sus datos.',
  'prompts.health.flowMapAsk.name': 'Mapa de flujo: pedido',
  'prompts.health.flowMapAsk.when': 'Cuando le preguntas a Claude sobre un mapa de flujo: cierra el borrador que queda en el escritor, no se envía.',
  'prompts.health.flowMapAsk.fixed': 'El archivo del mapa, los números de la ventana, lo que no se mide, la ejecución elegida y sus logs.'
}
