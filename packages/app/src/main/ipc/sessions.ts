import { shell, type BrowserWindow } from 'electron'
import { stat } from 'node:fs/promises'
import { claudeConsoleCommand, type ConfigurationService } from '@workhub/core'
import type { GitReview } from '@workhub/adapters/git-review'
import type { SessionMode, StartSessionInput } from '../../shared/api'
import type { SessionSnapshot } from '../../shared/windows-api'
import type { ChatJournals } from '../chat-journal'
import { createConversationExporter } from '../chat-export'
import type { ContinuityService } from '../continuity'
import type { IpcRegistrar } from '../ipc-guard'
import type { OwnerStarts } from '../owner-starts'
import { isRemoteSender, promptFromDevice } from '../remote'
import type { SessionDriver } from '../session-driver'
import type { SessionManager } from '../session-manager'
import { startPlaced } from '../session-placement'
import type { SessionWindows } from '../session-windows'

/** A question's answers from the renderer: question text to answer, strings only; anything else is dropped. */
function validAnswers(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const entries = Object.entries(v).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1].length <= 10_000)
  return entries.length > 0 ? Object.fromEntries(entries.slice(0, 10)) : undefined
}

export interface SessionsIpcDeps {
  sessions: SessionManager
  chatJournal: ChatJournals
  send: (channel: string, ...message: unknown[]) => void
  /** The main window as last created. */
  mainWindow: () => BrowserWindow | null
  /** The main window while it exists. */
  liveMain: () => BrowserWindow | null
  /** The main window listens: the sessions of the last run can be reopened. */
  sessionsWanted: () => void
  configuration: ConfigurationService
  configChanged: () => void
  ownerStarts: Pick<OwnerStarts, 'start'>
  driver: Pick<SessionDriver, 'typeInConsoleWhenSettled' | 'userPrompted' | 'userTyped'>
  localGit: Pick<GitReview, 'localChanges'>
  sessionWindows: SessionWindows
  continuity: Pick<ContinuityService, 'options' | 'failover' | 'handoff'>
}

/** Open sessions, their windows and moves to another account or agent (`sessions:*`, `windows:*`, `continuity:*`). */
export function registerSessionsIpc(ipc: IpcRegistrar, deps: SessionsIpcDeps): void {
  const { sessions, chatJournal, send, configuration, sessionWindows, continuity } = deps
  ipc.handle('sessions:list', () => sessions.list())
  ipc.handle('sessions:journal', (_e, id: unknown) => (typeof id === 'string' ? chatJournal.get(id) : null))
  ipc.on('sessions:ready', (e) => {
    const win = deps.mainWindow()
    if (!win || win.isDestroyed() || e.sender !== win.webContents) return
    deps.sessionsWanted()
  })
  // The New session dialog's Group: main saves the place, so it follows the session's identity.
  ipc.handle('sessions:start', (_e, input: StartSessionInput) =>
    startPlaced(input, {
      start: (rest) => sessions.start(rest),
      groups: async () => (await configuration.current()).sessionGroups,
      saveGroups: (g) => configuration.saveSessionGroups(g),
      replaceIdentity: (oldKey, newKey) => configuration.replaceSessionIdentity(oldKey, newKey),
      current: (id) => sessions.list().find((v) => v.id === id),
      changed: deps.configChanged
    })
  )
  ipc.handle('sessions:reopen', (_e, identity: string, input: StartSessionInput) => {
    if (typeof identity !== 'string' || !identity) throw new Error('an identity is required')
    return deps.ownerStarts.start(identity, input)
  })
  // A renderer's prompt carries a token: main says when it actually goes out (it may wait behind
  // a review or a Slack wake) and the renderer can take it back until then.
  ipc.handle('sessions:prompt', (e, id: string, text: string, images, token?: unknown) => {
    // A paired phone shows its own bubble; the windows get it the way they get Workhub's own prompts.
    if (isRemoteSender(e.sender.id)) {
      return promptFromDevice(
        {
          prompt: (sid, t, imgs, options) => sessions.prompt(sid, t, imgs, options),
          showPrompt: (sid, t) => {
            deps.driver.userPrompted(sid)
            send('automations:prompted', sid, t)
          },
          showTurnEnd: (sid, stopReason) => send('automations:turnEnded', sid, stopReason)
        },
        id,
        text,
        images
      )
    }
    // The user's own prompts: an automation lets go of a session the user talks in.
    if (typeof token !== 'number') return sessions.prompt(id, text, images, { onStart: () => deps.driver.userPrompted(id) })
    let started = false
    const onStart = () => {
      started = true
      deps.driver.userPrompted(id)
      // The sender shows its own bubble (with its images) and learns its number first, so the
      // broadcast that puts the prompt in the journal and every other window is not shown twice.
      if (!e.sender.isDestroyed()) e.sender.send('sessions:promptStarted', id, token, chatJournal.nextSeq(id))
      send('automations:prompted', id, text)
    }
    // Sent like the session's events (not with the invoke's answer, which can overtake them), so
    // the window ends the turn after its last message.
    const settled = () => {
      if (!e.sender.isDestroyed()) e.sender.send('sessions:promptSettled', id, token)
    }
    return sessions
      .prompt(id, text, images, { key: `${e.sender.id}:${token}`, onStart })
      .then((stopReason) => {
        if (started) send('automations:turnEnded', id, stopReason)
        return stopReason
      })
      .finally(settled)
  })
  ipc.handle('sessions:withdrawPrompt', (e, id: string, token: unknown) => typeof token === 'number' && sessions.withdrawPrompt(id, `${e.sender.id}:${token}`))
  ipc.handle('sessions:setMode', (_e, id: string, mode: SessionMode, options?: { now?: unknown }) => sessions.setMode(id, mode, { now: options?.now === true }))
  ipc.handle('sessions:close', (_e, id: string) => sessions.close(id))
  ipc.handle('sessions:closeRemovingWorktree', (_e, id: string, force: boolean) => sessions.closeRemovingWorktree(id, force === true))
  ipc.handle('sessions:setModel', (_e, id: string, model: string | null) => sessions.setModel(id, model))
  ipc.handle('sessions:setAgentMode', (_e, id: string, modeId: string) => {
    if (typeof modeId !== 'string' || !modeId) throw new Error('a mode id is required')
    return sessions.setAgentMode(id, modeId)
  })
  ipc.handle('sessions:typeInConsole', async (_e, id: string, command: string) => {
    // Only a terminal-bound slash command of a Claude chat session is ever typed; anything else is refused.
    const view = typeof id === 'string' ? sessions.list().find((v) => v.id === id) : undefined
    const line = typeof command === 'string' && view?.adapter === 'native' && view.modes?.includes('console') ? claudeConsoleCommand(command, view.commands) : null
    if (!line) throw new Error('this command cannot be typed into the console')
    await sessions.setMode(id, 'console', { now: true })
    return deps.driver.typeInConsoleWhenSettled(id, line)
  })
  ipc.on('sessions:mcp', (_e, id: string, action: 'refresh' | 'reconnect' | 'enable' | 'disable', server?: string) => sessions.mcp(id, action, server))
  ipc.handle('sessions:subagent', (_e, id: string, subagentId: string) => sessions.subagent(id, subagentId))
  ipc.handle('sessions:revealFile', async (_e, id: string, path: string) => {
    const target = sessions.fileInSession(id, path)
    if (!target || !(await stat(target).then(() => true, () => false))) return false
    shell.showItemInFolder(target)
    return true
  })
  ipc.handle('sessions:localChanges', async (_e, id: string) => {
    const cwd = sessions.cwdOf(id)
    return cwd ? deps.localGit.localChanges(cwd, sessions.changePathsOf(id)) : null
  })
  ipc.handle('sessions:rename', (_e, id: string, name: string | null) => {
    if (name !== null && typeof name !== 'string') throw new Error('a name is required')
    sessions.rename(id, name)
  })
  ipc.on('windows:openSession', (_e, id: string) => sessionWindows.open(id))
  ipc.on('windows:openSubagent', (_e, id: string, subagentId: string) => sessionWindows.openSubagent(id, subagentId))
  ipc.on('windows:dock', (_e, id: string) => sessionWindows.dock(id))
  ipc.handle('windows:detached', () => sessionWindows.detached())
  ipc.handle('windows:snapshot', (e, id: string) => sessionWindows.snapshot(id, e.sender))
  ipc.on('windows:snapshotReply', (_e, requestId: string, snapshot: SessionSnapshot | null) => sessionWindows.reply(requestId, snapshot))
  ipc.handle('sessions:cancel', (_e, id: string) => sessions.cancel(id))
  ipc.handle('sessions:keepWaiting', (_e, id: string) => sessions.keepWaiting(id))
  ipc.handle('sessions:stop', (_e, id: string) => sessions.stop(id))
  ipc.on('sessions:permission', (_e, id: string, requestId: string, optionId: string | null, answers?: unknown) =>
    sessions.respondPermission(id, requestId, optionId, validAnswers(answers))
  )
  ipc.on('sessions:write', (_e, id: string, data: string) => {
    deps.driver.userTyped(id, data)
    sessions.write(id, data)
  })
  ipc.on('sessions:resize', (_e, id: string, cols: number, rows: number) => sessions.resize(id, cols, rows))
  ipc.handle('sessions:exportConversation', createConversationExporter({ window: deps.liveMain }))
  ipc.handle('continuity:options', (_e, id: string) => continuity.options(id))
  ipc.handle('continuity:failover', (_e, id: string, request) => continuity.failover(id, request))
  ipc.handle('continuity:handoff', (_e, id: string, request) => continuity.handoff(id, request))
}
