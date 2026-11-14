import type { agentToolsEn } from './agentTools.en'

/** Spanish copy of Workhub's tools for agents (Settings → Agents → Workhub tools). */
export const agentToolsEs: Record<keyof typeof agentToolsEn, string> = {
  'agentTools.title': 'Herramientas de Workhub para agentes',
  'agentTools.help':
    'Cómo llegan a Workhub los agentes de tus sesiones: Plan, automatizaciones, historial, la revisión de sus cambios y mapas de flujo. El servidor MCP les da herramientas; las skills les enseñan cuándo y cómo usarlas. Pueden estar los dos.',
  'agentTools.mcp': 'Dar a las sesiones el servidor MCP de Workhub',
  'agentTools.mcpHint': 'Cada sesión nueva (salvo las revisoras) recibe las herramientas de Workhub. Suman algunos tokens a cada turno; Claude Code las carga a pedido cuando son muchas.',
  'agentTools.account': 'Carpeta de Claude Code',
  'agentTools.defaultAccount': 'Carpeta por defecto',
  'agentTools.skills': 'Skills',
  'agentTools.skillsHint': 'Copia las skills workhub-* a {dir}/skills. Las carpetas tuyas con el mismo nombre no se tocan.',
  'agentTools.skills.missing': 'Sin instalar',
  'agentTools.skills.current': 'Instaladas',
  'agentTools.skills.outdated': 'Hay una versión nueva',
  'agentTools.skills.own': 'Copia propia',
  'agentTools.install': 'Instalar',
  'agentTools.update': 'Actualizar',
  'agentTools.remove': 'Quitar',
  'agentTools.globalMcp': 'MCP fuera de Workhub',
  'agentTools.globalMcpHint': 'Agrega el servidor a la configuración de usuario de Claude Code, así `claude` en cualquier terminal llega a este Workhub mientras está abierto.',
  'agentTools.globalMcp.installed': 'Instalado',
  'agentTools.globalMcp.missing': 'Sin instalar',
  'agentTools.globalMcp.noClaude': 'No se encontró Claude Code',
  'agentTools.globalMcp.unavailable': 'No disponible acá',
  'agentTools.done': 'Listo',
  'agentTools.failed': 'No funcionó: {error}'
} as const
