/**
 * The Live boards bridge: a chat's board panel lists, reads and removes a profile's boards. Boards arrive
 * through the control endpoint (`boards.ts`), never through here. A board is addressed by its key
 * (`boardKey`: chat and id). Windows only.
 */
import type { BoardSummary, StoredBoard } from '@workhub/core'
import type { Boards } from './boards'
import type { IpcRegistrar } from './ipc-guard'

export interface BoardsIpcDeps {
  boards: Boards
  /** Whether Live boards is on for the profile; while it is off the boards are hidden (not deleted). */
  enabled(profileId: string): Promise<boolean>
}

/** A profile id or board key as an argument: a non-empty string of sane length. */
const ID_MAX = 200
const idOf = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 && v.length <= ID_MAX ? v : null)

export function registerBoardsIpc(ipc: IpcRegistrar, deps: BoardsIpcDeps): void {
  ipc.handle('boards:list', async (_e, profileId: unknown): Promise<BoardSummary[]> => {
    const profile = idOf(profileId)
    return profile && (await deps.enabled(profile)) ? deps.boards.list(profile) : []
  })
  ipc.handle('boards:get', async (_e, profileId: unknown, id: unknown): Promise<StoredBoard | null> => {
    const profile = idOf(profileId)
    const board = idOf(id)
    return profile && board && (await deps.enabled(profile)) ? deps.boards.get(profile, board) : null
  })
  ipc.handle('boards:remove', async (_e, profileId: unknown, id: unknown): Promise<boolean> => {
    const profile = idOf(profileId)
    const board = idOf(id)
    return profile && board && (await deps.enabled(profile)) ? deps.boards.remove(profile, board) : false
  })
}
