import { LayoutDashboard, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { boardLiveness, type BoardSummary, type StoredBoard } from '@workhub/core'
import { Button, IconButton, Select, StateDot } from '../../components/atoms'
import { ConfirmDeleteDialog } from '../../components/molecules'
import { PaneResizeHandle } from '../../components/molecules/PaneResizeHandle'
import { useI18n } from '../../i18n/I18nProvider'
import { keptRemoval, removeBoard, selectedBoardId, type RemoveTarget } from '../../lib/boards'
import { closeBoardPanel, panelFit, toggleBoardPanel } from '../../lib/boardPanel'
import { DEFAULT_PREFS, SIZE_RANGES, setPrefs, usePrefs } from '../../lib/prefs'
import { useNow } from '../../lib/usage'
import { BoardHeader } from './BoardHeader'
import { BoardView } from './BoardView'

/**
 * The boards of one chat, newest first, re-read whenever a board of its profile changes; empty while
 * Live boards is off for the profile, null until the first answer. A failed read keeps the last answer.
 */
export function useChatBoards(profileId: string | null, chat: string, visible: boolean): BoardSummary[] | null {
  const [boards, setBoards] = useState<BoardSummary[] | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => (profileId ? window.hub.boards.onChanged((p) => p === profileId && setTick((n) => n + 1)) : undefined), [profileId])
  useEffect(() => {
    if (!profileId || !visible) return
    let live = true
    window.hub.boards
      .list(profileId)
      .then((l) => live && setBoards(l.filter((b) => b.chat === chat)))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [profileId, chat, visible, tick])
  return boards
}

const liveness = (b: BoardSummary, now: number) => boardLiveness({ board: { status: b.status, heartbeatSeconds: b.heartbeatSeconds } as StoredBoard['board'], receivedAt: b.receivedAt }, now)

/** The chat bar's button that unfolds the chat's live board beside it; only there while the chat has sent one. */
export function ChatBoardsButton({ sessionId, profileId, chat, visible, open, compact = false }: { sessionId: string; profileId: string | null; chat: string; visible: boolean; open: boolean; compact?: boolean }) {
  const { t } = useI18n()
  const boards = useChatBoards(profileId, chat, visible)
  const now = useNow(visible ? 5_000 : 600_000)
  if (!profileId || !boards || boards.length === 0) return null
  const live = boards.some((b) => liveness(b, now) === 'live')
  const name = boards.length > 1 ? t('boards.panel.buttonCount', { n: boards.length }) : t('boards.panel.button')
  const label = live ? `${name} · ${t('boards.status.live')}` : name
  return (
    <Button
      size="sm"
      variant={open ? 'secondary' : 'ghost'}
      aria-pressed={open}
      aria-label={label}
      title={compact ? label : undefined}
      icon={live ? <StateDot tone="info" pulse /> : <LayoutDashboard className="size-3.5" aria-hidden />}
      onClick={() => toggleBoardPanel(sessionId)}
      data-testid="toggle-board-panel"
    >
      {!compact && name}
    </Button>
  )
}

/**
 * A chat's live board, over the right of the chat (the chat keeps its width and is covered, not squeezed): the whole board, with the same filter, boxes
 * and facts wherever a board is drawn. A chat with several boards picks one at the top (the newest
 * until one is picked). Resizable; its width is kept on this computer.
 */
export function ChatBoardPanel({ sessionId, profileId, chat, visible }: { sessionId: string; profileId: string | null; chat: string; visible: boolean }) {
  const { t } = useI18n()
  const prefs = usePrefs()
  const boards = useChatBoards(profileId, chat, visible)
  const now = useNow(visible ? 5_000 : 600_000)
  const [picked, setPicked] = useState<string | null>(null)
  const [dragging, setDragging] = useState<number | null>(null)
  const [stored, setStored] = useState<{ key: string; board: StoredBoard | null } | null>(null)
  const [removing, setRemoving] = useState<RemoveTarget | null>(null)
  const removal = keptRemoval(boards ?? [], removing)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const shown = selectedBoardId(boards ?? [], picked)
  // A failed removal is about the board it was asked for: picking another one clears it.
  useEffect(() => setRemoveError(null), [shown])
  // No board to show (removed, or Live boards turned off for the profile): the panel folds away with its button.
  const empty = boards !== null && boards.length === 0
  useEffect(() => {
    if (empty) closeBoardPanel(sessionId)
  }, [empty, sessionId])
  // A picked board that left the chat is forgotten, so a later re-send of it does not take the panel back.
  const pickGone = picked !== null && boards !== null && !boards.some((b) => b.key === picked)
  useEffect(() => {
    if (pickGone) setPicked(null)
  }, [pickGone])
  const [tick, setTick] = useState(0)
  useEffect(() => (profileId ? window.hub.boards.onChanged((p) => p === profileId && setTick((n) => n + 1)) : undefined), [profileId])
  useEffect(() => {
    if (!profileId || !shown || !visible) return
    let live = true
    window.hub.boards
      .get(profileId, shown)
      .then((board) => live && setStored({ key: shown, board }))
      .catch(() => live && setStored({ key: shown, board: null }))
    return () => {
      live = false
    }
  }, [profileId, shown, visible, tick])
  // The chat it floats over: the panel is never wider than that, nor does a drag start past it.
  const panel = useRef<HTMLElement>(null)
  const [room, setRoom] = useState<number | null>(null)
  useEffect(() => {
    const chat = panel.current?.parentElement
    if (!chat) return
    const read = () => setRoom(chat.clientWidth || null)
    read()
    const observer = new ResizeObserver(read)
    observer.observe(chat)
    return () => observer.disconnect()
  }, [])
  const fit = panelFit(dragging ?? prefs.boardPanelWidth, room, SIZE_RANGES.boardPanelWidth[0], SIZE_RANGES.boardPanelWidth[1])
  const width = fit.width
  const answered = stored !== null && stored.key === shown
  const board = answered ? stored.board : null

  return (
    <aside ref={panel} aria-label={t('boards.panel.label')} className="absolute inset-y-0 right-0 z-20 flex min-w-[min(20rem,100%)] max-w-full flex-col border-l border-border bg-bg shadow-xl" style={{ width }} data-board-panel-of={sessionId}>
      <PaneResizeHandle
        edge="left"
        width={width}
        min={Math.min(SIZE_RANGES.boardPanelWidth[0], fit.max)}
        max={fit.max}
        label={t('boards.panel.resize')}
        title={t('pane.resizeHint')}
        onWidth={(w, done) => {
          if (done) {
            // A click that moved nothing keeps the saved width (it may be wider than this chat, for a wider window).
            const moved = dragging !== null || w !== fit.width
            setDragging(null)
            if (moved) setPrefs({ boardPanelWidth: Math.max(SIZE_RANGES.boardPanelWidth[0], w) })
          } else setDragging(w)
        }}
        onReset={() => {
          setDragging(null)
          setPrefs({ boardPanelWidth: DEFAULT_PREFS.boardPanelWidth })
        }}
      />
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3.5 py-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.06em] text-subtle">{t('boards.panel.label')}</h2>
        <span className="flex-1" />
        {boards && boards.length > 1 && shown && (
          <Select
            aria-label={t('boards.panel.pick')}
            className="w-56"
            value={shown}
            onChange={(v) => setPicked(v || null)}
            options={boards.map((b) => ({ value: b.key, label: `${b.title} · ${t(LIVENESS_WORD[liveness(b, now)])}` }))}
          />
        )}
        {board && shown && (
          <IconButton size="sm" label={t('boards.remove.aria', { title: board.board.title })} icon={<Trash2 className="size-4" aria-hidden />} onClick={() => setRemoving({ key: shown, title: board.board.title })} />
        )}
        <IconButton size="sm" label={t('boards.panel.close')} icon={<X className="size-4" aria-hidden />} onClick={() => toggleBoardPanel(sessionId)} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
        {removeError && (
          <p className="text-sm text-danger" role="alert" data-testid="board-remove-failed">
            {removeError}
          </p>
        )}
        {board && shown && profileId ? (
          <>
            <BoardHeader stored={board} now={now} />
            <BoardView key={shown} profileId={profileId} boardKey={shown} stored={board} now={now} />
          </>
        ) : (
          <p className="text-sm text-muted" role="status">{answered || empty ? t('boards.panel.none') : t('boards.loading')}</p>
        )}
      </div>
      <ConfirmDeleteDialog
        name={removal?.title ?? ''}
        title={t('boards.remove.title', { title: removal?.title ?? '' })}
        description={t('boards.remove.body')}
        confirmLabel={t('boards.remove')}
        open={removal !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        onConfirm={() => {
          if (!removal || !profileId) return
          setRemoving(null)
          setRemoveError(null)
          void removeBoard(window.hub.boards.remove, profileId, removal.key, (message) => t('boards.remove.failed', { message })).then(setRemoveError)
        }}
      />
    </aside>
  )
}

const LIVENESS_WORD = { live: 'boards.status.live', silent: 'boards.monitor.silent', paused: 'boards.status.paused', finished: 'boards.status.finished', failed: 'boards.status.failed' } as const
