import { Bot, CircleAlert, Folder, History, MessagesSquare, RefreshCw, Search, SquareTerminal, UserRound } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { groupHistory } from '@workhub/core'
import type { HistoryItem, HistoryResult } from '@shared/api'
import { Badge, Button, IconButton, Input, Select, Spinner } from '../components/atoms'
import { EmptyState } from '../components/molecules'
import { useI18n } from '../i18n/I18nProvider'
import { folderName } from '../lib/home'
import { resumeInput } from '../lib/links'
import { readPrefs } from '../lib/prefs'
import { errorText } from '../lib/errorText'

export interface HistoryScreenProps {
  profileId: string | null
  onOpened: (sessionId: string) => void
}

/** Accounts present in the history, for the filter: `''` is Claude's default folder. */
export function historyAccounts(entries: HistoryItem[]): { id: string; name: string }[] {
  const seen = new Map<string, string>()
  for (const e of entries) if (!seen.has(e.accountId ?? '')) seen.set(e.accountId ?? '', e.accountName ?? '')
  return [...seen.entries()].map(([id, name]) => ({ id, name }))
}

/** Agents present in the history, for the filter. */
export function historyAgents(entries: HistoryItem[]): { id: string; name: string }[] {
  const seen = new Map<string, string>()
  for (const e of entries) if (!seen.has(e.agentId)) seen.set(e.agentId, e.agentName)
  return [...seen.entries()].map(([id, name]) => ({ id, name }))
}

const ALL = '*'

/** Every session of every agent that keeps a history, searchable, filterable by agent, grouped by folder. */
export function HistoryScreen({ profileId, onOpened }: HistoryScreenProps) {
  const { t, formatDate } = useI18n()
  const [result, setResult] = useState<HistoryResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [account, setAccount] = useState(ALL)
  const [agent, setAgent] = useState(ALL)
  const [error, setError] = useState('')
  const [opening, setOpening] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setResult(await window.hub.history.list())
    } catch (e) {
      setError(errorText(e))
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  const entries = useMemo(
    () => (result?.entries ?? []).filter((e) => (agent === ALL || e.agentId === agent) && (account === ALL || (e.accountId ?? '') === account)),
    [result, agent, account]
  )
  const groups = useMemo(() => groupHistory(entries, query), [entries, query])
  const accounts = useMemo(() => historyAccounts(result?.entries ?? []), [result])
  const agents = useMemo(() => historyAgents(result?.entries ?? []), [result])

  const resume = async (e: HistoryItem, mode: 'app' | 'console') => {
    setError('')
    setOpening(`${e.agentSessionId}:${mode}`)
    try {
      const view = await window.hub.sessions.start(await resumeInput(profileId, e, mode, (key) => readPrefs().models[key], () => window.hub.getDefaultCwd()))
      onOpened(view.id)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setOpening(null)
    }
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 px-8 py-6">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-subtle" aria-hidden />
          <Input aria-label={t('history.search')} placeholder={t('history.search')} value={query} onChange={(e) => setQuery(e.target.value)} className="pl-8!" spellCheck={false} />
        </div>
        {agents.length > 1 && (
          <div className="w-44 shrink-0">
            <Select
              aria-label={t('history.agent')}
              value={agent}
              onChange={setAgent}
              options={[{ value: ALL, label: t('history.allAgents') }, ...agents.map((a) => ({ value: a.id, label: a.name }))]}
            />
          </div>
        )}
        {accounts.length > 1 && (
          <div className="w-48 shrink-0">
            <Select
              aria-label={t('history.account')}
              value={account}
              onChange={setAccount}
              options={[{ value: ALL, label: t('history.allAccounts') }, ...accounts.map((a) => ({ value: a.id, label: a.name || t('usage.defaultAccount') }))]}
            />
          </div>
        )}
        <IconButton label={t('history.refresh')} icon={loading ? <Spinner className="size-4" /> : <RefreshCw className="size-4" />} disabled={loading} onClick={() => void load()} />
      </div>
      {error && (
        <p role="alert" className="flex items-center gap-2 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
          <CircleAlert className="size-4 shrink-0" aria-hidden />
          {error}
        </p>
      )}
      {result?.errors.map((e) => (
        <p key={e.account} role="alert" className="rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">
          {t('history.accountFailed', { account: e.account || t('usage.defaultAccount'), message: e.message })}
        </p>
      ))}
      {!result && loading && (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted">
          <Spinner className="size-4" />
          {t('history.loading')}
        </div>
      )}
      {result && groups.length === 0 && (
        <div className="py-12">
          <EmptyState icon={<History className="size-6" aria-hidden />} title={query ? t('history.noMatch') : t('history.empty')} description={t('history.emptyDescription')} />
        </div>
      )}
      {groups.map((g) => (
        <section key={g.folder} aria-label={g.folder || t('history.noFolder')} className="flex flex-col gap-1.5">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-muted" title={g.folder}>
            <Folder className="size-3.5 text-subtle" aria-hidden />
            {g.folder ? folderName(g.folder) : t('history.noFolder')}
            <span className="truncate font-mono text-xs font-normal text-subtle">{g.folder}</span>
            <span className="ml-auto text-xs font-normal text-subtle tabular-nums">{g.entries.length}</span>
          </h2>
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface">
            {g.entries.map((e) => {
              const accountName = e.accountName
              return (
                <li key={`${e.agentId}:${e.agentSessionId}`} className="flex items-center gap-3 px-3.5 py-2.5" data-testid="history-entry">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-base">{e.title || t('history.untitled')}</div>
                    <div className="flex items-center gap-2 text-xs text-subtle">
                      <span>{formatDate(e.lastModified, { dateStyle: 'medium', timeStyle: 'short' })}</span>
                      {e.gitBranch && e.gitBranch !== 'HEAD' && <span className="truncate font-mono">{e.gitBranch}</span>}
                      <Badge icon={<Bot className="size-3" aria-hidden />} className="h-4" data-testid="history-agent">
                        {e.agentName}
                      </Badge>
                      {accountName && (
                        <Badge icon={<UserRound className="size-3" aria-hidden />} className="h-4">
                          {accountName}
                        </Badge>
                      )}
                    </div>
                  </div>
                  {e.resumable && (
                    <>
                      <Button
                        size="sm"
                        variant="secondary"
                        icon={opening === `${e.agentSessionId}:app` ? <Spinner className="size-3" /> : <MessagesSquare className="size-3.5" aria-hidden />}
                        disabled={opening !== null}
                        onClick={() => void resume(e, 'app')}
                      >
                        {t('history.resume')}
                      </Button>
                      <IconButton
                        label={t('history.resumeConsole')}
                        icon={opening === `${e.agentSessionId}:console` ? <Spinner className="size-3.5" /> : <SquareTerminal className="size-4" />}
                        disabled={opening !== null}
                        onClick={() => void resume(e, 'console')}
                      />
                    </>
                  )}
                </li>
              )
            })}
          </ul>
        </section>
      ))}
    </div>
  )
}
