import { Search } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { HistoryMatch, HistorySearchResult } from '../../shared/api'
import { Spinner } from '../../renderer/components/atoms'
import { AgentIcon } from '../../renderer/components/atoms/AgentIcon'
import { HistoryIndexingNote, HistorySnippet, titleSnippetFits } from '../../renderer/components/molecules/HistorySnippet'
import { useI18n } from '../../renderer/i18n/I18nProvider'
import { folderName } from '../../renderer/lib/home'
import { useClientStatus, useConfig, useProfileId } from '../app-context'
import { NO_ANSWER_ERROR } from '../remote-client'
import { Body, Empty, Header, Screen } from '../ui'

const DEBOUNCE_MS = 300
const LIMIT = 50

/** The i18n key of a failed search: the computer offline or silent, else the message. */
export function searchErrorKey(message: string): 'web.history.offline' | 'web.history.noAnswer' | 'web.history.failed' {
  if (message === 'offline' || message === 'disconnected' || message === 'revoked') return 'web.history.offline'
  if (message === NO_ANSWER_ERROR) return 'web.history.noAnswer'
  return 'web.history.failed'
}

interface Found {
  query: string
  profileId: string | null
  entries: HistoryMatch[]
  progress: HistorySearchResult['progress']
  nextCursor?: string
}

/**
 * Search of the desktop's past sessions (its History index) in the folders of the profile, best
 * match first, with the text around each match. Read-only: a session resumes on the computer.
 */
export function HistoryScreen() {
  const { t } = useI18n()
  const status = useClientStatus()
  const { config } = useConfig()
  const [profileId] = useProfileId(config)
  const [query, setQuery] = useState('')
  const [settled, setSettled] = useState('')
  const [found, setFound] = useState<Found | null>(null)
  const [error, setError] = useState('')
  const [more, setMore] = useState(false)
  const online = status.state === 'online'
  useEffect(() => {
    const timer = setTimeout(() => setSettled(query.trim()), DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query])
  // Runs again when the computer comes back online.
  useEffect(() => {
    if (!settled) return
    let current = true
    setError('')
    window.hub.history.search(settled, { limit: LIMIT, profileId }).then(
      (r) => current && setFound({ query: settled, profileId, entries: r.entries, progress: r.progress, nextCursor: r.nextCursor }),
      (e: unknown) => current && setError(e instanceof Error ? e.message : String(e))
    )
    return () => {
      current = false
    }
  }, [settled, profileId, online])
  const data = found && found.query === settled && found.profileId === profileId ? found : null
  const loadMore = async () => {
    if (!data?.nextCursor || more) return
    setMore(true)
    try {
      const r = await window.hub.history.search(data.query, { limit: LIMIT, profileId: data.profileId, cursor: data.nextCursor })
      setFound((prev) => (prev === data ? { ...prev, entries: [...prev.entries, ...r.entries], progress: r.progress, nextCursor: r.nextCursor } : prev))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setMore(false)
    }
  }
  return (
    <Screen>
      <Header title={t('web.history.title')} back />
      <div className="border-b border-border px-3 py-2">
        <label className="flex min-h-11 items-center gap-2 rounded-xl border border-border bg-surface px-3">
          <Search className="size-4 shrink-0 text-subtle" aria-hidden />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('web.history.search')}
            aria-label={t('web.history.search')}
            className="min-h-11 min-w-0 flex-1 bg-transparent text-md outline-none"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            data-testid="web-history-search"
          />
        </label>
        <HistoryIndexingNote progress={data?.progress} className="mt-1.5" />
      </div>
      <Body>
        <HistorySearchBody profileName={config?.config.profiles.find((p) => p.id === profileId)?.name} settled={settled} data={data} error={error} loadingMore={more} onMore={() => void loadMore()} />
      </Body>
    </Screen>
  )
}

export interface HistorySearchBodyProps {
  /** The profile whose folders are searched, named in the empty state. */
  profileName?: string | undefined
  /** The search text once typing paused; empty before any. */
  settled: string
  data: { entries: HistoryMatch[]; nextCursor?: string } | null
  error: string
  loadingMore: boolean
  onMore: () => void
}

/** What the search shows under its box: the hint, a spinner, the error, no match, or the matches with "Load more". */
export function HistorySearchBody({ settled, data, error, loadingMore, onMore, profileName }: HistorySearchBodyProps) {
  const { t, formatDate } = useI18n()
  return (
    <>
      {error && (
        <p role="alert" className="px-4 pt-4 text-sm text-danger" data-testid="web-history-error">
          {t(searchErrorKey(error), { message: error })}
        </p>
      )}
      {!settled && <Empty title={t('web.history.search')} hint={t('web.history.hint')} />}
      {settled && !data && !error && <Spinner className="mx-auto mt-16 size-6" />}
      {settled && data && data.entries.length === 0 && <Empty title={t('web.history.empty')} hint={profileName ? t('web.history.emptyHint', { profile: profileName }) : undefined} />}
      {settled && data && data.entries.length > 0 && (
        <>
          <ul className="divide-y divide-border" data-testid="web-history-results">
            {data.entries.map((e) => (
              <li key={`${e.agentId}:${e.agentSessionId}`} className="px-4 py-3" data-testid="web-history-row">
                <div className="flex items-center gap-2">
                  <AgentIcon agentId={e.agentId} className="size-4 shrink-0 rounded-sm text-[9px]" />
                  <span className="truncate text-md font-medium">{titleSnippetFits(e.titleSnippet, e.title) ? <HistorySnippet text={e.titleSnippet} /> : e.title || t('history.untitled')}</span>
                </div>
                <div className="mt-0.5 truncate text-xs text-muted">
                  {formatDate(e.lastModified, { dateStyle: 'medium', timeStyle: 'short' })}
                  {e.cwd ? ` · ${folderName(e.cwd)}` : ''}
                </div>
                {e.snippet && <HistorySnippet text={e.snippet} className="mt-1 line-clamp-3 text-sm text-muted" />}
                <div className="mt-1 text-xs text-subtle">{t('web.history.resumeOnComputer')}</div>
              </li>
            ))}
          </ul>
          {data.nextCursor && (
            <button type="button" disabled={loadingMore} onClick={onMore} className="mx-auto my-4 flex min-h-11 items-center gap-2 rounded-xl border border-border-strong px-4 text-sm font-medium" data-testid="web-history-more">
              {loadingMore && <Spinner className="size-4" />}
              {t('web.history.loadMore')}
            </button>
          )}
        </>
      )}
    </>
  )
}
