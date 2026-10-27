import type { sessionsUxEn } from './sessionsUx.en'

/** Spanish copy of closing sessions from the sidebar and of a view switch that waits for the turn. */
export const sessionsUxEs: Record<keyof typeof sessionsUxEn, string> = {
  'sessions.close': 'Cerrar sesión',
  'sessions.closeNamed': 'Cerrar {name}',
  'sessions.closeTitle': '¿Cerrar {name}?',
  'sessions.closeBody': 'Está trabajando ahora: cerrarla detiene el turno en curso. La conversación queda en el Historial.',
  'sessions.closeConfirm': 'Detener y cerrar',
  'sessions.closeFailed': 'No se pudo cerrar la sesión: {message}',
  'session.pendingSwitch': 'Cambia a {mode} cuando termine el turno.',
  'session.pendingSwitchHint': 'Responde aquí cualquier pregunta; el cambio sigue al final del turno.',
  'session.switchNow': 'Cambiar ahora',
  'session.switchNowHint': 'Detener el turno en curso y cambiar de inmediato',
  'session.switchCancel': 'Cancelar',
  'session.switchCancelHint': 'Quedarse en esta vista',
  'session.switchPending': '{mode} (esperando el turno)'
}
