import type { MessageKey } from '../../i18n/translate'

/** `data-setting-id` of the rows of Settings → Agents; the search index names the same rows. */
export const AGENTS_ROW_IDS = {
  agents: 'agents.list',
  readingClaude: 'agents.reading.claude',
  readingCodex: 'agents.reading.codex',
  readingKiro: 'agents.reading.kiro',
  missing: 'agents.missing'
} as const

export interface SettingsIndexRow {
  id: string
  label: MessageKey
  hint?: MessageKey
  help?: MessageKey
  subgroup?: MessageKey
}

/** The rows of Settings → Agents for the settings search. */
export const AGENTS_INDEX: readonly SettingsIndexRow[] = [
  { id: AGENTS_ROW_IDS.agents, label: 'settingsAgents.addAccount', hint: 'settingsAgents.intro' },
  { id: AGENTS_ROW_IDS.readingClaude, label: 'settingsAgents.reading.claude', hint: 'settingsAgents.reading.claudeHint', help: 'settings.planUsageNote', subgroup: 'agentUsage.settings.reading' },
  { id: AGENTS_ROW_IDS.readingCodex, label: 'settingsAgents.reading.codex', hint: 'settingsAgents.reading.codexHint', help: 'agentUsage.settings.codexNote', subgroup: 'agentUsage.settings.reading' },
  { id: AGENTS_ROW_IDS.readingKiro, label: 'settingsAgents.reading.kiro', hint: 'settingsAgents.reading.kiroHint', help: 'agentUsage.settings.kiroNote', subgroup: 'agentUsage.settings.reading' },
  { id: AGENTS_ROW_IDS.missing, label: 'settingsAgents.missing.title', hint: 'settingsAgents.missing.hint' }
]
