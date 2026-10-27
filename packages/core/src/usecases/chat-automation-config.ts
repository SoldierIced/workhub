import type { AutomationDefinition } from '../automations/types'
import { DEFAULT_CHAT_WATCHER, type ChatWatcherSettings } from '../chat/types'
import type { WorkhubConfig } from '../config/schema'
import { fail, ok, type Result } from './validation'

/** The watcher settings with their defaults. */
export function chatWatcherSettings(config: Pick<WorkhubConfig, 'chatWatcher'>): ChatWatcherSettings {
  return { ...DEFAULT_CHAT_WATCHER, ...config.chatWatcher }
}

export function setChatWatcher(config: WorkhubConfig, settings: ChatWatcherSettings): Result<WorkhubConfig> {
  const ids = settings.channels.map((c) => c.id.trim())
  if (ids.some((id) => !id)) return fail([{ path: 'chatWatcher.channels', message: 'a channel needs its id' }])
  if (new Set(ids).size !== ids.length) return fail([{ path: 'chatWatcher.channels', message: 'a channel is listed twice' }])
  if (settings.accountId && !config.accounts.some((a) => a.id === settings.accountId)) return fail([{ path: 'chatWatcher.accountId', message: 'unknown account' }])
  return ok({ ...config, chatWatcher: { ...settings, channels: settings.channels.map((c) => ({ ...c, id: c.id.trim() })) } })
}

/** Adds or replaces an automation (by id). */
export function saveAutomation(config: WorkhubConfig, automation: AutomationDefinition): Result<WorkhubConfig> {
  if (!automation.name.trim()) return fail([{ path: `automations.${automation.id}.name`, message: 'a name is required' }])
  if (automation.profileId && !config.profiles.some((p) => p.id === automation.profileId)) {
    return fail([{ path: `automations.${automation.id}.profileId`, message: 'unknown profile' }])
  }
  const list = config.automations ?? []
  const automations = list.some((a) => a.id === automation.id) ? list.map((a) => (a.id === automation.id ? automation : a)) : [...list, automation]
  return ok({ ...config, automations })
}

export function deleteAutomation(config: WorkhubConfig, id: string): Result<WorkhubConfig> {
  const list = config.automations ?? []
  if (!list.some((a) => a.id === id)) return fail([{ path: `automations.${id}`, message: 'not found' }])
  return ok({ ...config, automations: list.filter((a) => a.id !== id) })
}
