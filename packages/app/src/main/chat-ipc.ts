import type { IpcRegistrar } from './ipc-guard'
import type { AutomationDefinition, ChatWatcherSettings, ConfigurationService, Result, WorkhubConfig } from '@workhub/core'
import type { SlackDemoInput, TrackThreadInput } from '../shared/chat-api'
import type { AutomationService } from './automations'
import type { SlackWatcherService } from './slack-watcher'

type Guard = <A extends unknown[]>(fn: (...args: A) => Promise<Result<WorkhubConfig>>) => (e: unknown, ...args: A) => Promise<Result<WorkhubConfig>>

/** IPC of the Slack watcher (`slack:*`) and the automations (`automations:*`). */
export function registerChatIpc(
  ipcMain: IpcRegistrar,
  deps: { slack: SlackWatcherService; automations: AutomationService; configuration: ConfigurationService; guarded: Guard }
): void {
  const { slack, automations, configuration, guarded } = deps
  ipcMain.handle('slack:get', () => slack.snapshot())
  ipcMain.handle(
    'slack:saveSettings',
    guarded(async (settings: ChatWatcherSettings) => {
      const r = await configuration.saveChatWatcher(settings)
      if (r.ok) {
        await slack.refreshHooks()
        void slack.tick()
      }
      return r
    })
  )
  ipcMain.handle('slack:runNow', () => slack.runNow())
  ipcMain.handle('slack:track', (_e, input: TrackThreadInput) => slack.track(input))
  ipcMain.handle('slack:trackMessage', (_e, channelId: string, ts: string) => slack.trackMessage(channelId, ts))
  ipcMain.handle('slack:setClosed', (_e, id: string, closed: boolean) => slack.setClosed(id, closed))
  ipcMain.handle('slack:setWake', (_e, id: string, wake: boolean) => slack.setWake(id, wake))
  ipcMain.handle('slack:remove', (_e, id: string) => slack.remove(id))
  ipcMain.handle('slack:sendToSession', (_e, id: string) => slack.sendToSession(id))
  ipcMain.handle('slack:markViewed', (_e, ids: string[]) => slack.markViewed(Array.isArray(ids) ? ids : []))
  // Edits the account's Claude settings.json: only ever reached from the user's click in Settings.
  ipcMain.handle('slack:setHook', (_e, accountId: string | null, install: boolean) => slack.setHook(accountId, install === true))
  ipcMain.handle('slack:demo', (_e, input: SlackDemoInput) => slack.demo(input))
  ipcMain.handle('slack:openOwner', (_e, id: string) => slack.openOwner(id))

  ipcMain.handle('automations:get', () => automations.snapshot())
  ipcMain.handle('automations:save', guarded((a: AutomationDefinition) => automations.save(a)))
  ipcMain.handle('automations:remove', guarded((id: string) => automations.remove(id)))
  ipcMain.handle('automations:setEnabled', guarded((id: string, enabled: boolean) => automations.setEnabled(id, enabled)))
  ipcMain.handle('automations:runNow', (_e, id: string) => automations.runNow(id))
  ipcMain.handle('automations:stop', (_e, id: string) => automations.stopRun(id))
  ipcMain.handle('automations:openSession', (_e, id: string) => automations.openSession(id).catch(() => null))
  ipcMain.on('automations:setViewing', (_e, id: string | null) => automations.setViewing(typeof id === 'string' ? id : null))
}
