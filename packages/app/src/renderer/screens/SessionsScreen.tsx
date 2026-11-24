import { CircleAlert, Plus } from 'lucide-react'
import { memo, useEffect, useState } from 'react'
import { sessionIdentity } from '@workhub/core'
import { terminalChannel } from '@shared/api'
import { Button, Spinner } from '../components/atoms'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { EmptyState } from '../components/molecules'
import { BrandMark } from '../components/organisms'
import { useI18n } from '../i18n/I18nProvider'
import { usePrefs } from '../lib/prefs'
import { useConfig } from '../configStore'
import { cn } from '../lib/cn'
import { useSession, type SessionData } from '../store'
import { AiReviewAside } from './sessions/AiReviewPanel'
import { ChatPane } from './sessions/ChatPane'
import { ChatBoardPanel } from './boards/ChatBoards'
import { useBoardPanelOpen } from '../lib/boardPanel'
import { MonitorPanel } from './sessions/MonitorPanel'
import { PendingSwitchBar } from './sessions/PendingSwitchBar'
import { SessionHeader } from './sessions/SessionHeader'
import { StallNotice } from './sessions/StallNotice'
import { SessionRequestsBar } from './sessions/SessionRequestsBar'
import { TerminalPane } from './sessions/TerminalPane'

export interface SessionsScreenProps {
  sessions: SessionData[]
  selectedId: string | null
  /** Whether the Sessions screen is on screen (panes stay mounted so terminals keep their state). */
  visible: boolean
  theme: 'light' | 'dark'
  onNewSession: () => void
}

export function SessionsScreen({ sessions, selectedId, visible, theme, onNewSession }: SessionsScreenProps) {
  const { t } = useI18n()
  const current = sessions.find((s) => s.view.id === selectedId)
  return (
    <div className="flex h-full min-h-0 flex-col">
      {sessions.map((s) => (
        <div key={s.view.id} className={cn('flex min-h-0 flex-1 flex-col', s.view.id !== current?.view.id && 'hidden')}>
          <ErrorBoundary where="session" variant="session">
            <DockedSessionPane row={s} visible={visible && s.view.id === current?.view.id} theme={theme} />
          </ErrorBoundary>
        </div>
      ))}
      {!current && (
        <div className="flex flex-1 items-center justify-center p-8">
          <EmptyState
            icon={<BrandMark className="size-8" />}
            title={sessions.length ? t('sessions.pick') : t('sessions.emptyTitle')}
            description={t('sessions.emptyDescription')}
            action={
              <Button variant="primary" icon={<Plus className="size-4" aria-hidden />} onClick={onNewSession}>
                {t('toolbar.newSession')}
              </Button>
            }
          />
        </div>
      )}
    </div>
  )
}

/**
 * A session's pane in the main window. It follows its own session in the store: the rows it gets
 * hold an older chat while a reply streams, and only this pane renders for each flush.
 */
const DockedSessionPane = memo(function DockedSessionPane({ row, visible, theme }: { row: SessionData; visible: boolean; theme: 'light' | 'dark' }) {
  const data = useSession(row.view.id) ?? row
  return <SessionPane data={data} visible={visible} theme={theme} />
})

/**
 * One session's header, chat or terminals and side panel. Rendered again only when that session
 * changes (or is shown or hidden), not each time the window renders: every open session stays
 * mounted, and re-rendering their chats on each sidebar click froze the window.
 */
export const SessionPane = memo(function SessionPane({ data, visible, theme }: { data: SessionData; visible: boolean; theme: 'light' | 'dark' }) {
  const { t } = useI18n()
  const v = data.view
  const monitorHidden = usePrefs().monitorHidden
  const boardPanel = useBoardPanelOpen(v.id)
  const config = useConfig()
  const profileId = v.profileId ?? config?.config.activeProfileId ?? null
  // A shell, once opened, stays mounted so its scrollback survives switching back and forth.
  const [shellOpened, setShellOpened] = useState(false)
  useEffect(() => {
    if (v.shellRunning) setShellOpened(true)
  }, [v.shellRunning])
  const hasApp = v.modes.includes('app')
  const hasConsole = v.modes.includes('console')
  return (
    <>
      <SessionHeader data={data} visible={visible} />
      {v.state === 'starting' && v.adapter === 'acp' && v.mode === 'app' && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-warning-soft px-4 py-1.5 text-sm text-warning">
          <Spinner className="size-3.5 text-warning" />
          {t('session.startingHint')}
        </div>
      )}
      <StallNotice view={v} />
      <PendingSwitchBar view={v} />
      <SessionRequestsBar sessionId={v.id} />
      {v.error && (
        <div role="alert" className="flex max-h-40 shrink-0 items-start gap-2 overflow-y-auto border-b border-border bg-danger-soft px-4 py-1.5 text-sm whitespace-pre-wrap text-danger">
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          {v.error}
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {hasApp && (
            <div className={cn('flex min-h-0 flex-1', v.mode !== 'app' && 'hidden')}>
              <ChatPane data={data} active={visible && v.mode === 'app'} />
            </div>
          )}
          {hasConsole && (
            <div className={cn('flex min-h-0 flex-1', v.mode !== 'console' && 'hidden')}>
              <TerminalPane channel={terminalChannel(v.id, 'console')} visible={visible && v.mode === 'console'} theme={theme} label={t('session.modeConsole')} />
            </div>
          )}
          {shellOpened && (
            <div className={cn('flex min-h-0 flex-1', v.mode !== 'shell' && 'hidden')}>
              <TerminalPane channel={terminalChannel(v.id, 'shell')} visible={visible && v.mode === 'shell'} theme={theme} label={t('session.modeShell')} />
            </div>
          )}
        </div>
        {/* The chat's live board, unfolded with the Board button of its bar. */}
        {boardPanel && <ChatBoardPanel sessionId={v.id} profileId={profileId} chat={sessionIdentity(v)} visible={visible} />}
        {/* Folded away with the session header's monitor button (⇧⌘M), as Workhub 1's Inspector. */}
        {monitorHidden ? null : v.screens.includes('monitor') ? <MonitorPanel data={data} visible={visible} /> : <AiReviewAside view={v} />}
      </div>
    </>
  )
})
