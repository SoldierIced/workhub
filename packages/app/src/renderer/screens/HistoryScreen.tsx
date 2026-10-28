import { ChevronRight, CircleAlert, Folder, History, MessagesSquare, Search, Settings, SquareTerminal, UserRound } from 'lucide-react'
import { AgentIcon } from '../components/atoms/AgentIcon'
import { ContextMenu } from 'radix-ui'
import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react'
import { groupAutomationHistory, groupHistory, historyId, historyInProfile, isThrowawayFolder, owningProfile, type FolderProfile, type Profile } from '@workhub/core'
import type { HistoryItem, HistoryResult, SessionView } from '@shared/api'
import { Badge, Button, IconButton, Input, Select, Spinner } from '../components/atoms'
import { EmptyState, useToast, RefreshButton } from '../components/molecules'
import { useI18n } from '../i18n/I18nProvider'
import { useSessions } from '../store'
import { folderName } from '../lib/home'
import { resumeInput } from '../lib/links'
import { readPrefs } from '../lib/prefs'
import { errorText } from '../lib/errorText'

export interface HistoryScreenProps {
  profileId: string | null
  /** Every profile, for the profile filter. */
  profiles?: Profile[]
  onOpened: (sessionId: string) => void
  /** False while another screen shows; the list reloads in the background when History comes back. */
  visible?: boolean
}

export interface HistoryFilter {
  /** An agent id, or `*` for every agent. */
  agent: string
  /** An account id (`''`: the default folder), or `*` for every account. */
  account: string
  /** Only this profile's sessions (the folders it owns and its accounts); undefined for every profile. */
  profile?: Partial<FolderProfile> & Pick<Profile, 'accountIds'>
  /** Every profile, so a folder goes to the profile that owns it (see `owningProfile`). */
  profiles?: readonly FolderProfile[]
  /** Expands `~` in the profiles' folders. */
  home?: string
}

/** The entries History lists: never throwaway runs in temporary folders, then the agent, account and profile filters. */
export function visibleHistory(entries: readonly HistoryItem[], filter: HistoryFilter): HistoryItem[] {
  return entries.filter(
    (e) =>
      !isThrowawayFolder(e.cwd) &&
      (filter.agent === ALL || e.agentId === filter.agent) &&
      (filter.account === ALL || (e.accountId ?? '') === filter.account) &&
      (!filter.profile || historyInProfile(e, filter.profile, { profiles: filter.profiles, home: filter.home }))
  )
}

/** The open sessions by `historyId`, so a history row can say "Open" and show it instead of resuming it again. */
export function openSessionsByHistory(views: readonly SessionView[]): Map<string, string> {
  const open = new Map<string, string>()
  for (const v of views) {
    if (v.state === 'stopped' || v.state === 'error' || !v.agentSessionId) continue
    open.set(historyId({ agentId: v.agentId, agentSessionId: v.agentSessionId }), v.id)
  }
  return open
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
export function HistoryScreen({ profileId, profiles = [], onOpened, visible = true }: HistoryScreenProps) {
  const { t, tn, formatDate } = useI18n()
  const toast = useToast()
  const sessionMap = useSessions()
  const open = useMemo(() => openSessionsByHistory(Object.values(sessionMap).map((s) => s.view)), [sessionMap])
  // Workhub 1 lists the active profile's sessions unless "All profiles" is picked.
  const [profileFilter, setProfileFilter] = useState(profileId ?? ALL)
  useEffect(() => setProfileFilter(profileId ?? ALL), [profileId])
  const [result, setResult] = useState<HistoryResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  // Grouping and fuzzy matching run on the settled text, so typing never waits for them.
  const deferredQuery = useDeferredValue(query)
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
    if (visible) void load()
  }, [load, visible])

  const [home, setHome] = useState<string | undefined>()
  useEffect(() => {
    void window.hub.getDefaultCwd().then(setHome, () => setHome(undefined))
  }, [])
  const filterProfile = profiles.length > 1 ? profiles.find((p) => p.id === profileFilter) : undefined
  const entries = useMemo(() => visibleHistory(result?.entries ?? [], { agent, account, profile: filterProfile, profiles, home }), [result, agent, account, filterProfile, profiles, home])
  // An automation's runs collapse into one row per automation; the other sessions group by folder.
  const [hideAutomations, setHideAutomations] = useState(false)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const byAutomation = useMemo(() => groupAutomationHistory(entries, deferredQuery), [entries, deferredQuery])
  const groups = useMemo(() => groupHistory(byAutomation.rest, deferredQuery), [byAutomation, deferredQuery])
  const automationGroups = hideAutomations ? [] : byAutomation.groups
  const toggleAutomation = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      return next
    })
  const accounts = useMemo(() => historyAccounts(result?.entries ?? []), [result])
  const agents = useMemo(() => historyAgents(result?.entries ?? []), [result])
  // Long histories render a page at a time: every row carries a context menu, and one folder can hold hundreds.
  const [limit, setLimit] = useState(HISTORY_PAGE)
  useEffect(() => setLimit(HISTORY_PAGE), [deferredQuery, agent, account, profileFilter, hideAutomations])
  const page = useMemo(() => pageGroups(groups, limit), [groups, limit])

  const resume = async (e: HistoryItem, mode: 'app' | 'console') => {
    // Already open: show it rather than start a second copy of the conversation.
    const live = open.get(historyId(e))
    if (live && mode === 'app') return onOpened(live)
    setError('')
    setOpening(`${e.agentSessionId}:${mode}`)
    try {
      // A past session reopens in the profile that owns its folder, else the active one.
      const owner = owningProfile(e.cwd, profiles, home)?.id ?? profileId
      const view = await window.hub.sessions.start(await resumeInput(owner, e, mode, (key) => readPrefs().models[key], () => window.hub.getDefaultCwd()))
      onOpened(view.id)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setOpening(null)
    }
  }

  const revealFolder = async (folder: string) => {
    if (!(await window.hub.history.revealFolder(folder))) toast(t('history.revealFailed'), 'danger')
  }
  const copyId = async (id: string) => {
    try {
      await navigator.clipboard.writeText(id)
      toast(t('history.copied'))
    } catch (err) {
      toast(errorText(err), 'danger')
    }
  }

  /** One past session: its row, its resume buttons and its menu. */
  const renderEntry = (e: HistoryItem) => {
    const accountName = e.accountName
    return (
      <ContextMenu.Root key={`${e.agentId}:${e.agentSessionId}`}>
        <ContextMenu.Trigger asChild>
          <li
            className="flex items-center gap-3 px-3.5 py-2.5 select-none"
            data-testid="history-entry"
            onDoubleClick={() => e.resumable && opening === null && void resume(e, 'app')}
          >
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-base">{e.title || t('history.untitled')}</span>
                {open.has(historyId(e)) && (
                  <Badge tone="success" className="h-4 shrink-0" title={t('history.openHint')} data-testid="history-open">
                    {t('history.open')}
                  </Badge>
                )}
              </div>
              <div className="flex items-center gap-2 text-xs text-subtle">
                <span>{formatDate(e.lastModified, { dateStyle: 'medium', timeStyle: 'short' })}</span>
                {e.gitBranch && e.gitBranch !== 'HEAD' && <span className="truncate font-mono">{e.gitBranch}</span>}
                <Badge icon={<AgentIcon agentId={e.agentId} className="size-4 rounded-sm text-[9px]" />} className="h-5" data-testid="history-agent">
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
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content className={MENU_CONTENT}>
            {e.resumable && (
              <>
                <ContextMenu.Item className={MENU_ITEM} onSelect={() => void resume(e, 'app')}>
                  {t('history.resumeApp')}
                </ContextMenu.Item>
                <ContextMenu.Item className={MENU_ITEM} onSelect={() => void resume(e, 'console')}>
                  {t('history.resumeInConsole')}
                </ContextMenu.Item>
                <ContextMenu.Separator className="my-1 h-px bg-border" />
              </>
            )}
            {e.cwd && (
              <ContextMenu.Item className={MENU_ITEM} onSelect={() => void revealFolder(e.cwd!)}>
                {t('history.revealFolder')}
              </ContextMenu.Item>
            )}
            <ContextMenu.Item className={MENU_ITEM} onSelect={() => void copyId(e.agentSessionId)}>
              {t('history.copyId')}
            </ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
    )
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
        {profiles.length > 1 && (
          <div className="w-44 shrink-0">
            <Select
              aria-label={t('history.profile')}
              value={profileFilter}
              onChange={setProfileFilter}
              options={[{ value: ALL, label: t('history.allProfiles') }, ...profiles.map((p) => ({ value: p.id, label: p.name }))]}
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
        {(byAutomation.groups.length > 0 || hideAutomations) && (
          <Button size="md" variant={hideAutomations ? 'primary' : 'secondary'} aria-pressed={hideAutomations} onClick={() => setHideAutomations(!hideAutomations)} data-testid="history-hide-automations">
            {t('history.hideAutomations')}
          </Button>
        )}
        <RefreshButton size="md" iconClassName="size-4" label={t('history.refresh')} loading={loading} onRefresh={load} />
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
      {result && groups.length === 0 && automationGroups.length === 0 && (
        <div className="py-12">
          <EmptyState icon={<History className="size-6" aria-hidden />} title={query ? t('history.noMatch') : t('history.empty')} description={t('history.emptyDescription')} />
        </div>
      )}
      {automationGroups.length > 0 && (
        <section aria-label={t('history.automations')} className="flex flex-col gap-1.5" data-testid="history-automations">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-muted">
            <Settings className="size-3.5 text-subtle" aria-hidden />
            {t('history.automations')}
          </h2>
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface">
            {automationGroups.map((g) => {
              const isOpen = expanded.has(g.automationId)
              const today = g.entries.filter((e) => e.lastModified >= startOfToday()).length
              return (
                <li key={g.automationId} data-testid="history-automation-group">
                  <button
                    type="button"
                    className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left hover:bg-accent-soft/40"
                    aria-expanded={isOpen}
                    onClick={() => toggleAutomation(g.automationId)}
                  >
                    <ChevronRight className={`size-3.5 shrink-0 text-subtle transition-transform ${isOpen ? 'rotate-90' : ''}`} aria-hidden />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-base">{g.name || t('history.untitled')}</div>
                      <div className="text-xs text-subtle" data-testid="history-automation-summary">
                        {tn('history.automationRuns', g.entries.length, { today })} · {t('history.automationLast', { time: formatDate(g.lastModified, { dateStyle: 'medium', timeStyle: 'short' }) })}
                      </div>
                    </div>
                  </button>
                  {isOpen && <ul className="flex flex-col divide-y divide-border border-t border-border bg-surface-raised/40 pl-6">{g.entries.map(renderEntry)}</ul>}
                </li>
              )
            })}
          </ul>
        </section>
      )}
      {page.groups.map((g) => (
        <section key={g.folder} aria-label={g.folder || t('history.noFolder')} className="flex flex-col gap-1.5">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-muted" title={g.folder}>
            <Folder className="size-3.5 text-subtle" aria-hidden />
            {g.folder ? folderName(g.folder) : t('history.noFolder')}
            <span className="truncate font-mono text-xs font-normal text-subtle">{g.folder}</span>
            <span className="ml-auto text-xs font-normal text-subtle tabular-nums">{g.total}</span>
          </h2>
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface">
            {g.entries.map(renderEntry)}
          </ul>
        </section>
      ))}
      {page.hidden > 0 && (
        <Button variant="secondary" className="self-center" onClick={() => setLimit((n) => n + HISTORY_PAGE)} data-testid="history-show-more">
          {t('history.showMore', { hidden: page.hidden })}
        </Button>
      )}
      {result && groups.length > 0 && <p className="text-xs text-subtle">{t('history.doubleClick')}</p>}
    </div>
  )
}

/** Epoch ms of today's local midnight, for "N today". */
function startOfToday(): number {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** Rows shown before "Show more". */
export const HISTORY_PAGE = 50

/**
 * The first `limit` rows across the folder groups, in order. `total` keeps each folder's real count
 * for its heading; `hidden` is how many rows stay unrendered.
 */
export function pageGroups<E, G extends { entries: E[] }>(groups: readonly G[], limit: number): { groups: (G & { total: number })[]; hidden: number } {
  const out: (G & { total: number })[] = []
  let left = Math.max(0, limit)
  let hidden = 0
  for (const g of groups) {
    const total = g.entries.length
    if (left >= total) {
      out.push({ ...g, total })
      left -= total
    } else {
      if (left > 0) out.push({ ...g, entries: g.entries.slice(0, left), total })
      hidden += total - left
      left = 0
    }
  }
  return { groups: out, hidden }
}

const MENU_CONTENT = 'z-50 min-w-48 animate-fade-in rounded-md border border-border bg-surface-raised p-1 shadow-lg'
const MENU_ITEM = 'flex h-8 cursor-default select-none items-center rounded-sm px-2 text-base outline-none data-[highlighted]:bg-accent-soft'
