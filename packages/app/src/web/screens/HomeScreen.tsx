import { Plus, X } from 'lucide-react'
import { useState } from 'react'
import type { SessionState } from '@workhub/core'
import { useI18n } from '../../renderer/i18n/I18nProvider'
import { cn } from '../../renderer/lib/cn'
import { awaitingAnswer, useSessions, type SessionData } from '../../renderer/store'
import { navigate, useClientStatus } from '../app-context'
import { basename, Body, DesktopPicker, Empty, Header, InlineConfirm, Row, Screen } from '../ui'

const DOT: Record<SessionState, string> = {
  starting: 'bg-warning',
  ready: 'bg-success',
  busy: 'bg-accent animate-pulse',
  stopped: 'bg-border-strong',
  error: 'bg-danger'
}

export function sessionTitle(s: SessionData): string {
  return s.view.name ?? s.view.agentTitle ?? s.view.label
}

/** The sessions open on the desktop, newest first; a tap opens the chat. */
export function HomeScreen() {
  const { t } = useI18n()
  const status = useClientStatus()
  const sessions = useSessions()
  const [closing, setClosing] = useState<string | null>(null)
  const list = Object.values(sessions)
    .filter((s) => !s.view.readOnly)
    .sort((a, b) => Number(awaitingAnswer(b)) - Number(awaitingAnswer(a)) || b.view.startedAt - a.view.startedAt)
  const desktop = status.desktop?.name ?? ''

  const close = (id: string) => {
    setClosing(null)
    void window.hub.sessions.close(id).catch(() => {})
  }

  return (
    <Screen>
      <Header
        title={t('web.home.title')}
        subtitle={status.desktops.length > 1 ? <DesktopPicker /> : status.state === 'online' ? t('web.state.online', { desktop }) : t('web.home.offlineCache')}
        right={
          <button type="button" onClick={() => navigate({ screen: 'new' })} className="flex h-9 items-center gap-1 rounded-full bg-accent pr-3.5 pl-2.5 text-sm font-semibold text-accent-fg">
            <Plus className="size-4" aria-hidden />
            {t('web.home.new')}
          </button>
        }
      />
      <Body>
        {list.length === 0 ? (
          <Empty title={t('web.home.empty', { desktop })} hint={t('web.home.emptyHint')} />
        ) : (
          <ul className="divide-y divide-border">
            {list.map((s) => {
              const waiting = awaitingAnswer(s)
              return (
                <li key={s.view.id}>
                  {closing === s.view.id ? (
                    <div className="px-4 py-2">
                      <InlineConfirm question={t('web.home.closeConfirm')} yes={t('web.home.closeYes')} onYes={() => close(s.view.id)} onNo={() => setClosing(null)} danger />
                    </div>
                  ) : (
                    <Row
                      onClick={() => navigate({ screen: 'session', id: s.view.id })}
                      right={
                        <button
                          type="button"
                          aria-label={t('web.close')}
                          onClick={(e) => {
                            e.stopPropagation()
                            setClosing(s.view.id)
                          }}
                          className="flex size-9 shrink-0 items-center justify-center rounded-lg text-subtle active:bg-surface-hover"
                        >
                          <X className="size-4" aria-hidden />
                        </button>
                      }
                    >
                      <div className="flex items-center gap-2">
                        <span className={cn('size-2 shrink-0 rounded-full', DOT[s.view.state])} aria-hidden />
                        <span className="truncate text-md font-medium">{sessionTitle(s)}</span>
                      </div>
                      <div className="mt-0.5 flex items-center gap-2 text-xs text-muted">
                        <span className="truncate font-mono">{basename(s.view.cwd)}</span>
                        <span aria-hidden>·</span>
                        <span className="truncate">{s.view.agentName}</span>
                        {waiting && <span className="ml-auto shrink-0 rounded-full bg-warning-soft px-2 py-px text-2xs font-semibold text-warning">{t('web.home.needsAnswer')}</span>}
                      </div>
                    </Row>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </Body>
    </Screen>
  )
}
