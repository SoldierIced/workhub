import { useEffect, useRef } from 'react'
import { groupOf, notificationTitle, sessionIdentity, TRAY_ROUTES, type SessionGroups, type TrayRoute, type TraySession } from '@workhub/core'
import { awaitingAnswer, type SessionData } from '../store'
import { sessionLabel } from './sessionGroups'
import type { Locale } from '../i18n/translate'

/**
 * The sessions as the menu bar icon lists them: named like their sidebar row (`sessionLabel`,
 * after the group's name when grouped), with the unseen flag only the renderer keeps. AI reviewer
 * sessions are left out: their review reports them.
 */
export function traySessions(sessions: readonly SessionData[], groups: SessionGroups): TraySession[] {
  return sessions
    .filter((s) => !s.view.readOnly)
    .map((s) => {
      const group = groupOf(groups, sessionIdentity(s.view))
      const out: TraySession = { id: s.view.id, title: notificationTitle(sessionLabel(s), group?.name), state: s.view.state }
      if (s.view.agentId) out.agentId = s.view.agentId
      if (s.unseen) out.unseen = s.unseen
      if (awaitingAnswer(s)) out.awaitingAnswer = true
      return out
    })
}

export interface TraySyncDeps {
  sessions: readonly SessionData[]
  groups: SessionGroups
  locale: Locale
  navigate: (route: TrayRoute) => void
  newSession: () => void
}

/** Keeps the menu bar icon in step with the sessions and the language, and follows its menu. */
export function useTraySync({ sessions, groups, locale, navigate, newSession }: TraySyncDeps): void {
  const last = useRef('')
  useEffect(() => {
    const state = { locale, sessions: traySessions(sessions, groups) }
    const key = JSON.stringify(state)
    if (key === last.current) return
    last.current = key
    window.hub.tray.setState(state)
  }, [sessions, groups, locale])

  const latest = useRef({ navigate, newSession })
  latest.current = { navigate, newSession }
  useEffect(() => {
    const offNavigate = window.hub.tray.onNavigate((route) => {
      if (TRAY_ROUTES.includes(route)) latest.current.navigate(route)
    })
    const offNew = window.hub.tray.onNewSession(() => latest.current.newSession())
    return () => {
      offNavigate()
      offNew()
    }
  }, [])
}
