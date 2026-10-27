import type { continuityEn } from './continuity.en'

/** Spanish copy of session continuity (neutral). Same keys as `continuityEn`. */
export const continuityEs: Record<keyof typeof continuityEn, string> = {
  'continuity.menu': 'Continuar en otro lado',
  'continuity.menu.loading': 'Cargando…',
  'continuity.menu.accounts': 'Continuar en otra cuenta',
  'continuity.menu.accountsHint': 'La misma conversación: la transcripción se copia a la otra cuenta y se retoma allí.',
  'continuity.menu.noAccounts': 'Ninguna otra cuenta de Claude de este perfil está por debajo de su techo.',
  'continuity.menu.handoff': 'Pasar a…',
  'continuity.menu.handoffHint': 'Una sesión nueva de ese agente en esta carpeta, con un resumen redactado en su compositor. El otro agente recibe un resumen, no la conversación.',
  'continuity.menu.noHandoff': 'Este perfil no ofrece otro agente con chat.',
  'continuity.menu.summarize': 'Pedirle al agente que resuma (usa un turno de esta cuenta)',
  'continuity.menu.busy': 'Espera a que termine el turno, o interrúmpelo, antes de mover la sesión.',

  'continuity.offer.limit': '{account} alcanzó su límite de uso.',
  'continuity.offer.limitWindow': '{account} alcanzó su límite de {window}.',
  'continuity.offer.ceiling': '{account} superó tu techo.',
  'continuity.offer.resets': 'Se restablece en {time}.',
  'continuity.offer.continueIn': 'Continuar en {account}',
  'continuity.offer.handOffTo': 'Pasar a {agent}',
  'continuity.offer.wait': 'Esperar',

  'continuity.origin.failover': 'Continúa en {account}: {from} alcanzó su límite de {window}.',
  'continuity.origin.failoverNoWindow': 'Continúa en {account}: {from} alcanzó su límite de uso.',
  'continuity.origin.failoverCeiling': 'Continúa en {account}: {from} superó tu techo de {window}.',
  'continuity.origin.failoverCeilingNoWindow': 'Continúa en {account}: {from} superó tu techo.',
  'continuity.origin.failoverManual': 'Continúa en {account} (movida desde {from}).',
  'continuity.origin.handoff': 'Recibida de {from}. El texto de abajo es un resumen de esa sesión, no su conversación.',

  'continuity.toast.moved': 'Continúa en {account}.',
  'continuity.toast.handedOff': 'Traspaso a {agent} redactado. Revisa el resumen y luego envíalo.',
  'continuity.toast.summaryFailed': 'El agente no pudo escribir el resumen; Workhub lo armó a partir de la transcripción.',
  'continuity.toast.failed': 'No se pudo continuar la sesión: {message}',
  'continuity.notify.title': 'Límite de uso: {account}',
  'continuity.notify.body': 'Continúa en otra cuenta, pasa la sesión a otro agente o espera.',

  'continuity.settings.legend': 'Cuando una cuenta de Claude se queda sin uso',
  'continuity.settings.mode': 'Cambio de cuenta',
  'continuity.settings.ask': 'Preguntar',
  'continuity.settings.automatic': 'Automático',
  'continuity.settings.off': 'Desactivado',
  'continuity.settings.hint':
    'Cuando una cuenta de Claude alcanza su límite de uso, o tu techo de Ajustes → Uso, su sesión puede continuar en la siguiente cuenta de Claude de este perfil (según el orden de agentes) que esté por debajo de sus techos. Preguntar lo ofrece en el chat; Automático cambia por su cuenta y le pide a Claude que siga. La conversación pasa completa: sus archivos se copian a la otra cuenta, nunca se mueven ni se sobrescriben.'
}
