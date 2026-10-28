import { useMemo } from 'react'
import { pullRequestSlackLinks, slackLinkSummary, threadsOfSession, type ChatMessage, type ChatWatcherSettings, type Profile, type SlackLinkSummary, type TrackedThread } from '@workhub/core'
import type { TrackThreadInput } from '@shared/chat-api'
import { useSlack } from '../chatStore'

export interface SlackLinks {
  messages: ChatMessage[]
  threads: TrackedThread[]
  summary: SlackLinkSummary | null
  me: string
}

const NONE: SlackLinks = { messages: [], threads: [], summary: null, me: '' }

/** What Slack holds about a pull request: messages that link it and threads about it, with the badge summary. */
export function usePullRequestSlack(url: string | undefined): SlackLinks {
  const snap = useSlack()
  return useMemo(() => {
    if (!snap || !url) return NONE
    const links = pullRequestSlackLinks(snap.messages, snap.threads, url)
    return { ...links, summary: slackLinkSummary(links, snap.me), me: snap.me }
  }, [snap, url])
}

/** The open threads a session owns (by its stable identity), with the badge summary. */
export function useSessionSlack(identity: string | undefined): SlackLinks {
  const snap = useSlack()
  return useMemo(() => {
    if (!snap || !identity) return NONE
    const threads = threadsOfSession(snap.threads, identity)
    return { messages: [], threads, summary: slackLinkSummary({ messages: [], threads }, snap.me), me: snap.me }
  }, [snap, identity])
}

/**
 * What keeps the monitor from showing a session's Slack messages, as a hint to fix it in Settings:
 * Slack is off for the profile (`module`), the watcher is off (`watcher`, its default) or it
 * watches no channel (`channels`). Null when the watcher reads.
 */
export type SlackSetupHint = 'module' | 'watcher' | 'channels'

export function slackSetupHint(profile: Pick<Profile, 'modules'> | undefined, settings: Pick<ChatWatcherSettings, 'enabled' | 'channels'>): SlackSetupHint | null {
  if (profile && !profile.modules.chatWatcher) return 'module'
  if (!settings.enabled) return 'watcher'
  if (settings.channels.length === 0) return 'channels'
  return null
}

/** What the "Track a Slack thread" sheet holds. */
export interface TrackForm {
  permalink: string
  title: string
  prUrl: string
  ticketKey: string
  /** View id of the session to link; empty for none. */
  sessionId: string
  wake: boolean
}

/** The request for the watcher: trimmed, empty fields left out, and wake only with a session to wake. */
export function trackInput(form: TrackForm): TrackThreadInput {
  const text = (v: string) => v.trim() || undefined
  const sessionId = text(form.sessionId)
  const input: TrackThreadInput = { permalink: form.permalink.trim() }
  const title = text(form.title)
  const prUrl = text(form.prUrl)
  const ticketKey = text(form.ticketKey)?.toUpperCase()
  if (title) input.title = title
  if (prUrl) input.prUrl = prUrl
  if (ticketKey) input.ticketKey = ticketKey
  if (sessionId) {
    input.sessionId = sessionId
    input.wake = form.wake
  }
  return input
}
