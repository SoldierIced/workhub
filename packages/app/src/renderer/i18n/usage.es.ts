import type { usageEn } from './usage.en'

/** Spanish copy of usage per agent account (neutral). Same keys as `usageEn`. */
export const usageEs: Record<keyof typeof usageEn, string> = {
  'agentUsage.title': 'Uso por agente',
  'agentUsage.agent.claude': 'Claude',
  'agentUsage.agent.codex': 'Codex',
  'agentUsage.agent.kiro': 'Kiro',
  'agentUsage.defaultAccount': 'Cuenta por defecto',
  'agentUsage.empty': 'Todavía no hay uso. Activa la lectura por agente en Ajustes → Uso, o inicia una sesión que lo informe.',
  'agentUsage.openSettings': 'Ajustes de uso',
  'agentUsage.resetsIn': 'se restablece en {time}',
  'agentUsage.asOf': 'de un archivo de sesión, {when}',
  'agentUsage.readFailed': 'No se pudo leer el uso',
  'agentUsage.ceiling': 'techo {ceiling}%',
  'agentUsage.state.warn': 'Cerca del techo',
  'agentUsage.state.block': 'Sobre el techo',
  'agentUsage.kiro': 'Los créditos y límites restantes no están disponibles: Kiro no los expone localmente.',
  'agentUsage.kiroCredits': 'Las sesiones de esta ejecución usaron {credits} créditos.',

  'agentUsage.gate.block': '{account} está en {percent}% de su ventana {window}, por encima de tu techo de {ceiling}%.',
  'agentUsage.gate.resets': 'Se restablece en {time}.',
  'agentUsage.gate.confirm': 'Enviar requiere tu confirmación.',
  'agentUsage.gate.sendAnyway': 'Enviar de todos modos',
  'agentUsage.gate.clear': 'Quitar el techo',
  'agentUsage.gate.warn': '{account} está en {percent}% de su ventana {window}; el techo es {ceiling}%.',

  'agentUsage.settings.tab': 'Uso',
  'agentUsage.settings.reading': 'Lectura',
  'agentUsage.settings.claude': 'Leer el uso del plan de Claude por cuenta',
  'agentUsage.settings.codex': 'Leer el uso del plan de Codex por cuenta',
  'agentUsage.settings.codexHint': 'Cada 5 minutos, con el inicio de sesión de Codex de cada cuenta, o desde sus archivos de sesión más recientes.',
  'agentUsage.settings.codexNote':
    'Desactivado por defecto. Llama a un endpoint no documentado de ChatGPT con el inicio de sesión guardado en la carpeta de Codex de la cuenta (auth.json); puede cambiar o dejar de funcionar en cualquier momento. Workhub nunca renueva ni guarda ese inicio de sesión. Sin él, o si el endpoint falla, se muestran los límites más recientes que Codex escribió en sus archivos de sesión.',
  'agentUsage.settings.kiro': 'Kiro',
  'agentUsage.settings.kiroNote': 'No disponible: Kiro informa los créditos que usó cada turno, pero no los créditos ni los límites que quedan.',
  'agentUsage.settings.budgets': 'Presupuestos',
  'agentUsage.settings.budgetsNote':
    'Por encima de un techo, los prompts enviados desde Workhub a esa cuenta requieren "Enviar de todos modos", y las automatizaciones, los despertares y las lecturas de Slack en esa cuenta esperan hasta que la ventana se restablezca o el techo se suba o se quite. "Ejecutar ahora" en una automatización igual se ejecuta una vez. No se instala nada en los agentes: el control vive solo en Workhub, y deja pasar todo mientras el uso es desconocido.',
  'agentUsage.settings.noAccounts': 'Activa la lectura de Claude o Codex para definir presupuestos.',
  'agentUsage.settings.ceiling': 'Techo de {window} (%)',
  'agentUsage.settings.none': 'Sin techo',
  'agentUsage.settings.clear': 'Quitar',
  'agentUsage.settings.current': 'ahora {percent}%',
  'agentUsage.settings.margin': 'Margen de aviso',
  'agentUsage.settings.marginHint': 'Puntos por debajo de un techo donde empieza el aviso.',
  'agentUsage.settings.alerts': 'Alertas',
  'agentUsage.settings.alertsOn': 'Avisar cuando el uso cruza un umbral o un techo',
  'agentUsage.settings.alertsHint': 'Una vez por umbral y ventana, hasta que la ventana se restablezca.',
  'agentUsage.settings.thresholds': 'Umbrales (%)',
  'agentUsage.settings.thresholdsHint': 'Separados por comas, por ejemplo 80, 95.',
  'agentUsage.settings.apply': 'Aplicar',

  'agentUsage.alert.title': 'Uso: {account}',
  'agentUsage.alert.threshold': 'Ventana {window} en {percent}% (umbral {threshold}%), se restablece en {time}.',
  'agentUsage.alert.ceiling': 'Ventana {window} en {percent}%: se alcanzó el techo de {threshold}%. El trabajo automático en esta cuenta espera; se restablece en {time}.'
}
