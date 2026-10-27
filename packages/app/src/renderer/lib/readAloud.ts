import { useEffect, useRef, useSyncExternalStore } from 'react'
import { speechText, SPEECH_RATE_RANGE, type AppOptions } from '@workhub/core'
import type { Platform } from '@shared/api'
import type { ChatItem, SessionData } from '../store'
import { shortcutKeys, type Shortcut } from './shortcuts'

/** Stop speaking: Option/Alt + Command/Ctrl + `.` (Workhub 1's File ▸ Stop Speaking). */
export const STOP_SPEAKING_SHORTCUT: Shortcut = { key: '.', alt: true }

export const stopSpeakingKeys = (platform: Platform): string => shortcutKeys(STOP_SPEAKING_SHORTCUT, platform).join(platform === 'mac' ? '' : '+')

/** `.` is a different character under Option on macOS, so the physical key decides. */
export function isStopSpeakingShortcut(e: { code: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }, platform: Platform): boolean {
  const mod = platform === 'mac' ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  return mod && e.altKey && !e.shiftKey && e.code === 'Period'
}

/** Web Speech rate 1 is about this many words per minute. */
const WPM_AT_RATE_ONE = 175

export function wpmToRate(wpm: number): number {
  const clamped = Math.min(SPEECH_RATE_RANGE[1], Math.max(SPEECH_RATE_RANGE[0], wpm))
  return Math.round((clamped / WPM_AT_RATE_ONE) * 100) / 100
}

/**
 * The reply that ended the last turn: the agent's messages after the previous user message or turn
 * end, joined. Null when the last item is not a finished turn (or it was cancelled).
 */
export function lastFinishedReply(items: readonly ChatItem[]): { turnId: number; markdown: string } | null {
  let end = -1
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i]!.kind === 'turnEnd') {
      end = i
      break
    }
  }
  if (end < 0) return null
  const turn = items[end] as Extract<ChatItem, { kind: 'turnEnd' }>
  if (turn.stopReason === 'cancelled') return null
  const parts: string[] = []
  for (let i = end - 1; i >= 0; i--) {
    const item = items[i]!
    if (item.kind === 'user' || item.kind === 'turnEnd') break
    if (item.kind === 'agent') parts.unshift(item.text)
  }
  return { turnId: turn.id, markdown: parts.join('\n\n') }
}

// --- Speaking -------------------------------------------------------------------------------

let speakingId: string | null = null
let current: SpeechSynthesisUtterance | null = null
const speakingListeners = new Set<() => void>()
const emitSpeaking = () => speakingListeners.forEach((l) => l())

const synth = (): SpeechSynthesis | null => (typeof speechSynthesis === 'undefined' ? null : speechSynthesis)

export function stopSpeaking(): void {
  synth()?.cancel()
  current = null
  if (speakingId !== null) {
    speakingId = null
    emitSpeaking()
  }
}

/** What a request for `id` speaks with. */
export interface SpeakOptions {
  /** What the speech was started for: a session ("reply:<id>") or "voice-test". */
  id: string
  /** A voice name; empty: the system voice. */
  voice: string
  wpm: number
}

/** Reads `markdown` aloud (cleaned of code, links and marks); a new request stops the one in progress. Returns whether anything was spoken. */
export function speak(markdown: string, { id, voice, wpm }: SpeakOptions): boolean {
  const s = synth()
  const text = speechText(markdown)
  if (!s || !text) return false
  s.cancel()
  const utterance = new SpeechSynthesisUtterance(text)
  utterance.rate = wpmToRate(wpm)
  const chosen = voice ? s.getVoices().find((v) => v.name === voice) : undefined
  if (chosen) {
    utterance.voice = chosen
    utterance.lang = chosen.lang
  }
  const done = () => {
    if (current !== utterance) return
    current = null
    speakingId = null
    emitSpeaking()
  }
  utterance.onend = done
  utterance.onerror = done
  current = utterance
  speakingId = id
  emitSpeaking()
  s.speak(utterance)
  return true
}

export function useSpeakingId(): string | null {
  return useSyncExternalStore(
    (l) => {
      speakingListeners.add(l)
      return () => speakingListeners.delete(l)
    },
    () => speakingId
  )
}

/** The installed voices, once the system has listed them. */
export function useVoices(): SpeechSynthesisVoice[] {
  return useSyncExternalStore(
    (l) => {
      synth()?.addEventListener('voiceschanged', l)
      return () => synth()?.removeEventListener('voiceschanged', l)
    },
    voicesSnapshot
  )
}

let voicesCache: SpeechSynthesisVoice[] = []
function voicesSnapshot(): SpeechSynthesisVoice[] {
  const now = synth()?.getVoices() ?? []
  if (now.length !== voicesCache.length || now.some((v, i) => v !== voicesCache[i])) voicesCache = now
  return voicesCache
}

// --- Per-session switch ---------------------------------------------------------------------

const enabled = new Map<string, boolean>()
let enabledVersion = 0
const enabledListeners = new Set<() => void>()

export function setSessionReadAloud(id: string, on: boolean): void {
  enabled.set(id, on)
  enabledVersion++
  enabledListeners.forEach((l) => l())
  if (!on && speakingId === `reply:${id}`) stopSpeaking()
}

export const isSessionReadAloud = (id: string): boolean => enabled.get(id) === true

/** Re-renders when any session's switch changes (the sidebar menu reads `isSessionReadAloud`). */
export function useReadAloudVersion(): number {
  return useSyncExternalStore(
    (l) => {
      enabledListeners.add(l)
      return () => enabledListeners.delete(l)
    },
    () => enabledVersion
  )
}

/**
 * Whether a session seen for the first time starts with reading aloud on (Settings → Voice), as
 * Workhub 1 does: only a session the user starts now. One Workhub opened on its own (automation,
 * review, Slack), one running before this window opened, and one resumed (a session brought back
 * after a relaunch, reopened from the sidebar or History) start off.
 */
export function readsAloudByDefault(view: SessionData['view'], defaultOn: boolean, openedAt: number): boolean {
  return defaultOn && view.startedAt >= openedAt - 1000 && !view.origin && !view.readOnly && !view.resumed
}

/**
 * Reads each new finished reply of the sessions that have the switch on; what a session held when
 * it was first seen (its earlier conversation) is never read.
 */
export function useReadAloud(sessions: Record<string, SessionData>, options: Pick<AppOptions, 'readAloud' | 'speechVoice' | 'speechRate'>, platform: Platform): void {
  const seen = useRef(new Map<string, number>())
  const openedAt = useRef(Date.now())
  const latest = useRef(options)
  latest.current = options

  useEffect(() => {
    for (const [id, data] of Object.entries(sessions)) {
      const reply = lastFinishedReply(data.items)
      if (!seen.current.has(id)) {
        seen.current.set(id, reply?.turnId ?? 0)
        if (!enabled.has(id) && readsAloudByDefault(data.view, latest.current.readAloud, openedAt.current)) setSessionReadAloud(id, true)
        continue
      }
      if (!reply || reply.turnId === seen.current.get(id)) continue
      seen.current.set(id, reply.turnId)
      if (!isSessionReadAloud(id)) continue
      speak(reply.markdown, { id: `reply:${id}`, voice: latest.current.speechVoice, wpm: latest.current.speechRate })
    }
  }, [sessions])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isStopSpeakingShortcut(e, platform)) return
      e.preventDefault()
      stopSpeaking()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [platform])
}
