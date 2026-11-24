import type { BoardSummary, StoredBoard } from '@workhub/core'

// Types of the Live boards bridge (window.hub.boards). Boards are sent by tools through the control
// endpoint; a chat's board panel only reads and removes them. Windows only: not offered to paired devices.
export interface BoardsApi {
  /** The profile's boards, newest first; empty when the module is off for it. */
  list(profileId: string): Promise<BoardSummary[]>
  /** A board by its key (`BoardSummary.key`: its chat and id). */
  get(profileId: string, key: string): Promise<StoredBoard | null>
  /** Removes a board; true when there was one. Its tool may send it again. */
  remove(profileId: string, key: string): Promise<boolean>
  /** A board of any profile arrived, changed or was removed (its key). */
  onChanged(cb: (profileId: string, key: string) => void): () => void
}
