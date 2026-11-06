import type { profileAgentsEn } from './profileAgents.en'

export const profileAgentsEs: Record<keyof typeof profileAgentsEn, string> = {
  'profileAgents.title': 'Agentes que ofrece este perfil, en orden',
  'profileAgents.hint': 'Arrastrá ⋮⋮ o usá ↑↓',
  'profileAgents.ownSignIn': 'su propio inicio de sesión',
  'profileAgents.notOffered': 'no se ofrece en este perfil',
  'profileAgents.usage': '{percent} %',
  'profileAgents.default': 'Predeterminado',
  'profileAgents.drag': 'Arrastrar {name}',
  'profileAgents.up': 'Mover {name} hacia arriba',
  'profileAgents.down': 'Mover {name} hacia abajo',
  'profileAgents.offer': 'Ofrecer {name}',
  'profileAgents.footnote': 'Predeterminado = la primera fila ofrecida. La usan Nueva sesión, abrir una sesión desde un PR o un ticket, y la revisión previa al PR cuando no elegiste revisor.',
  'profileAgents.noProfile': 'Este perfil ya no existe.',
  'profileAgents.switch.title': 'Cambio de cuenta',
  'profileAgents.switch.label': 'Si una cuenta de Claude llega a su límite',
  'profileAgents.switch.ask': 'Preguntarme',
  'profileAgents.switch.automatic': 'Automático',
  'profileAgents.switch.off': 'Nunca',
  'profileAgents.switch.hint': 'La sesión sigue con la siguiente cuenta de Claude de la lista de arriba (acá: {order}), con el mismo contexto',
  'profileAgents.switch.only': '{name} es la única cuenta de Claude ofrecida: no hay a cuál cambiar',
  'profileAgents.switch.none': 'Este perfil no ofrece ninguna cuenta de Claude: no hay a cuál cambiar',
  'newSession.agentDefault': '{label} (predeterminado)',
  'newSession.agentUsage': '{label} · {percent} %',
  'newSession.orderAgents': 'Ordenar y elegir los agentes de {profile}…',
  'newSession.accountDefaultModel': 'El de la cuenta'
} as const
