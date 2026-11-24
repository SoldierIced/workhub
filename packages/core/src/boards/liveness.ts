import type { StoredBoard } from './types'

export type BoardLiveness = 'live' | 'silent' | 'paused' | 'finished' | 'failed'

/** How often a tool reports while live when it declares nothing. */
export const DEFAULT_HEARTBEAT_SECONDS = 60

/**
 * What the screen shows for a board: its own status, except that a `live` board with no news for
 * more than three heartbeats is `silent` (the tool, its session or Workhub may be gone).
 */
export function boardLiveness(stored: Pick<StoredBoard, 'board' | 'receivedAt'>, now: number): BoardLiveness {
  const { status, heartbeatSeconds } = stored.board
  if (status !== 'live') return status
  return now - stored.receivedAt > 3 * (heartbeatSeconds ?? DEFAULT_HEARTBEAT_SECONDS) * 1000 ? 'silent' : 'live'
}
