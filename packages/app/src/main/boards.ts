/**
 * The Live boards: what a tool running in a session sends to `POST /v1/boards`, kept per profile.
 * One `StateStore<BoardsState>` per profile (a row of the database, written at most every few
 * seconds); a profile's row is read once, through `sanitizeBoardsState`, then lives in memory.
 */
import {
  boardKey,
  boardsOf,
  EMPTY_BOARDS,
  moduleScreens,
  parseBoard,
  putBoard,
  removeBoard,
  sanitizeBoardsState,
  summarize,
  type BoardsState,
  type BoardSummary,
  type ModuleToggles,
  type StateStore,
  type StoredBoard
} from '@workhub/core'
import type { ControlCaller } from './control-auth'
import { resolveControlProfile, type ControlProfileDeps } from './plan-control'

export interface BoardsDeps {
  /** The state of one profile's boards: `(id) => db.state<BoardsState>('boards:' + id, 5000)` in the app. */
  stateFor(profileId: string): StateStore<BoardsState>
  /** A board of the profile arrived, changed or was removed. */
  changed(profileId: string, boardId: string): void
}

export type SaveBoardOutcome = ReturnType<typeof putBoard>

export interface Boards {
  /** Stores a parsed board for a chat (the same id of the same chat replaces it); announces it when stored. */
  save(profileId: string, board: Parameters<typeof putBoard>[1], sessionId: string | undefined, now: number, chat?: string): SaveBoardOutcome
  /** The profile's boards, newest first. */
  list(profileId: string): BoardSummary[]
  /** The board with that key (`boardKey`). */
  get(profileId: string, key: string): StoredBoard | null
  /** True when there was a board with that key. */
  remove(profileId: string, key: string): boolean
}

export function createBoards(deps: BoardsDeps): Boards {
  const stores = new Map<string, StateStore<BoardsState>>()
  const states = new Map<string, BoardsState>()

  /** The profile's store; a failure to create it is not remembered, so the next call tries again. */
  const storeOf = (profileId: string): StateStore<BoardsState> => {
    let store = stores.get(profileId)
    if (!store) stores.set(profileId, (store = deps.stateFor(profileId)))
    return store
  }

  const stateOf = (profileId: string): BoardsState => {
    const kept = states.get(profileId)
    if (kept) return kept
    let store: StateStore<BoardsState>
    try {
      store = storeOf(profileId)
    } catch {
      // No store, so nothing known about this profile: read as empty, but not kept (the next call tries again)
      // and `persist` refuses to save, so a board is never acknowledged without being written.
      return EMPTY_BOARDS
    }
    let stored: BoardsState
    try {
      // `load` merges only the top level over the fallback: what comes back is checked, never trusted.
      stored = sanitizeBoardsState(store.load(EMPTY_BOARDS))
    } catch {
      stored = EMPTY_BOARDS
    }
    states.set(profileId, stored)
    return stored
  }

  /** Writes first, remembers after: when the store cannot be had or refuses, this throws and nothing changes. */
  const persist = (profileId: string, next: BoardsState): void => {
    storeOf(profileId).save(next)
    states.set(profileId, next)
  }

  return {
    save(profileId, board, sessionId, now, chat) {
      const put = putBoard(stateOf(profileId), board, now, sessionId, chat)
      if (!put.ok) return put
      persist(profileId, put.state)
      deps.changed(profileId, boardKey({ chat, board }))
      // A board the cap pushed out, or the key a taken-over board had, disappears from the screen too.
      for (const gone of put.dropped) deps.changed(profileId, boardKey(gone))
      if (put.retired) deps.changed(profileId, put.retired)
      return put
    },
    list: (profileId) => boardsOf(stateOf(profileId)).map(summarize),
    get: (profileId, key) => stateOf(profileId).boards.find((s) => boardKey(s) === key) ?? null,
    remove(profileId, key) {
      const out = removeBoard(stateOf(profileId), key)
      if (!out.removed) return false
      persist(profileId, out.state)
      deps.changed(profileId, key)
      return true
    }
  }
}

/** What `POST /v1/boards` answers: the body of a 200, or the status and text of a refusal. */
export type SaveBoardResult = { ok: true; id: string; dropped: string[] } | { ok: false; status: number; error: string; errors?: string[] }

export interface BoardSaverDeps extends ControlProfileDeps {
  boards: Boards
  /** The profile's module toggles; undefined when the profile does not exist. */
  modules(profileId: string): Promise<ModuleToggles | undefined>
  /** The chat a running session belongs to (its identity, kept across restarts and resumes); undefined when it is not running. */
  chatOf(sessionId: string): string | undefined
  now?: () => number
}

export const BOARDS_OFF = 'Live boards is off for this profile: the user turns it on in Settings → Profiles → Screens'
export const BOARDS_FULL = 'This profile already shows 12 live boards: one must finish or be removed before a new one can be sent'

/** Whether Live boards is on for a profile. */
export async function boardsOn(deps: Pick<BoardSaverDeps, 'modules'>, profileId: string): Promise<boolean> {
  return moduleScreens(await deps.modules(profileId)).includes('boards')
}

/**
 * The control endpoint's save: the profile of the proven caller (never one named in the body), the
 * module on for it, a document that parses, room for it. On this route 409 means only "off" or "full".
 */
export function createBoardSaver(deps: BoardSaverDeps): (board: unknown, caller: ControlCaller) => Promise<SaveBoardResult> {
  return async (input, caller) => {
    if (!caller) return { ok: false, status: 401, error: 'this needs the session token: send X-Workhub-Token: $WORKHUB_SESSION_TOKEN' }
    const who = await resolveControlProfile(deps, { session: caller.session }, { write: true })
    if (!who.ok) return { ok: false, status: who.status === 403 ? 403 : 404, error: who.error }
    const modules = await deps.modules(who.profileId)
    if (!modules) return { ok: false, status: 404, error: 'the profile of this session no longer exists' }
    if (!moduleScreens(modules).includes('boards')) return { ok: false, status: 409, error: BOARDS_OFF }
    const parsed = parseBoard(input)
    if (!parsed.ok) return { ok: false, status: 400, error: parsed.errors.join('; '), errors: parsed.errors }
    const chat = deps.chatOf(caller.session)
    const saved = deps.boards.save(who.profileId, parsed.board, caller.session, (deps.now ?? Date.now)(), chat)
    if (!saved.ok) return { ok: false, status: 409, error: BOARDS_FULL }
    // The tool hears only of its own chat's boards: another chat's board with the same id is not its.
    return { ok: true, id: parsed.board.id, dropped: saved.dropped.filter((d) => d.chat === chat).map((d) => d.board.id) }
  }
}
