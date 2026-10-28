import { Bot, GitBranch, History, Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { historyId, sessionsOfFolder } from '@workhub/core'
import type { HistoryItem } from '@shared/api'
import { useI18n } from '../../i18n/I18nProvider'
import { cn } from '../../lib/cn'
import { errorText } from '../../lib/errorText'
import { folderName } from '../../lib/home'
import { resumeInput } from '../../lib/links'
import { readPrefs } from '../../lib/prefs'
import { Badge } from '../atoms/Badge'
import { Button } from '../atoms/Button'
import { Input } from '../atoms/Input'
import { Spinner } from '../atoms/Spinner'
import { Dialog } from '../molecules/Dialog'
import { EmptyState } from '../molecules/EmptyState'

export interface ResumeSheetProps {
  /** The folder whose earlier sessions are offered; null: closed. */
  folder: string | null
  profileId: string | null
  onClose: () => void
  onOpened: (sessionId: string) => void
}

type Load = { state: 'loading' } | { state: 'ready'; entries: HistoryItem[]; open: ReadonlySet<string> } | { state: 'error'; message: string }

/**
 * Workhub 1's "Resume session…" of a folder: the earlier sessions run there, newest first, with
 * their branch and first prompt, searchable; the ones open now are left out.
 */
export function ResumeSheet({ folder, profileId, onClose, onOpened }: ResumeSheetProps) {
  const { t, formatDate } = useI18n()
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const listRef = useRef<HTMLUListElement>(null)

  useEffect(() => {
    if (!folder) return
    let alive = true
    setLoad({ state: 'loading' })
    setQuery('')
    setError('')
    void Promise.all([window.hub.history.list(), window.hub.sessions.list()]).then(
      ([history, live]) => {
        if (!alive) return
        const open = new Set(live.filter((s) => s.state !== 'stopped' && s.state !== 'error' && s.agentSessionId).map((s) => historyId({ agentId: s.agentId, agentSessionId: s.agentSessionId! })))
        setLoad({ state: 'ready', entries: history.entries.filter((e) => e.resumable), open })
      },
      (e: unknown) => alive && setLoad({ state: 'error', message: errorText(e) })
    )
    return () => {
      alive = false
    }
  }, [folder])

  const list = useMemo(() => (load.state === 'ready' && folder ? sessionsOfFolder(load.entries, folder, load.open, query) : []), [load, folder, query])
  // The newest session is picked when the list (re)appears, or when the picked one is filtered out.
  useEffect(() => {
    if (!list.some((e) => historyId(e) === selected)) setSelected(list[0] ? historyId(list[0]) : null)
  }, [list, selected])

  if (!folder) return null
  const current = list.find((e) => historyId(e) === selected)

  const resume = async (entry: HistoryItem | undefined, mode: 'app' | 'console') => {
    if (!entry || busy) return
    setBusy(true)
    setError('')
    try {
      const view = await window.hub.sessions.start(await resumeInput(profileId, entry, mode, (key) => readPrefs().models[key], () => window.hub.getDefaultCwd()))
      onOpened(view.id)
      onClose()
    } catch (e) {
      setError(t('resume.failed', { message: errorText(e) }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('resume.title')}
      description={`${folderName(folder)} · ${folder}`}
      className="w-[min(640px,calc(100vw-48px))]"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="secondary" disabled={!current || busy} onClick={() => void resume(current, 'console')}>
            {t('resume.resumeConsole')}
          </Button>
          <Button variant="primary" data-testid="resume-selected" disabled={!current || busy} icon={busy ? <Spinner className="size-3.5" /> : undefined} onClick={() => void resume(current, 'app')}>
            {t('resume.resume')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-subtle" aria-hidden />
          <Input
            autoFocus
            aria-label={t('resume.search')}
            placeholder={t('resume.search')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(k) => {
              // Return resumes the highlighted session; ↓ moves into the list.
              if (k.key === 'Enter') return void resume(current, 'app')
              if (k.key !== 'ArrowDown') return
              k.preventDefault()
              listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus()
            }}
            className="pl-8!"
            spellCheck={false}
          />
        </div>
        {error && (
          <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}
        <div className="h-80 overflow-y-auto rounded-lg border border-border bg-surface">
          {load.state === 'loading' && (
            <p className="flex items-center justify-center gap-2 py-16 text-sm text-muted">
              <Spinner className="size-4" /> {t('resume.loading')}
            </p>
          )}
          {load.state === 'error' && (
            <p role="alert" className="px-3 py-6 text-sm text-danger">
              {load.message}
            </p>
          )}
          {load.state === 'ready' && list.length === 0 && (
            <div className="py-10">
              <EmptyState icon={<History className="size-6" aria-hidden />} title={query ? t('resume.noMatch') : t('resume.empty')} description={t('resume.emptyBody')} />
            </div>
          )}
          {list.length > 0 && (
            <ul ref={listRef} role="listbox" aria-label={t('resume.title')} className="flex flex-col divide-y divide-border">
              {list.map((e) => {
                const id = historyId(e)
                const picked = id === selected
                return (
                  <li
                    key={id}
                    role="option"
                    aria-selected={picked}
                    tabIndex={picked ? 0 : -1}
                    data-testid="resume-entry"
                    onClick={() => setSelected(id)}
                    onDoubleClick={() => void resume(e, 'app')}
                    onKeyDown={(k) => {
                      if (k.key === 'Enter') void resume(e, 'app')
                      const step = k.key === 'ArrowDown' ? 1 : k.key === 'ArrowUp' ? -1 : 0
                      if (!step) return
                      k.preventDefault()
                      const next = list[list.indexOf(e) + step]
                      if (!next) return
                      setSelected(historyId(next))
                      // Focus follows the pick, so the highlighted row is the one that gets the next key.
                      const row = step > 0 ? k.currentTarget.nextElementSibling : k.currentTarget.previousElementSibling
                      if (row instanceof HTMLElement) row.focus()
                    }}
                    className={cn('flex cursor-default flex-col gap-0.5 px-3 py-2 outline-none focus-visible:ring-1 focus-visible:ring-accent/40 focus-visible:ring-inset', picked ? 'bg-accent-soft' : 'hover:bg-surface-hover')}
                  >
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-base font-medium">{e.title || t('history.untitled')}</span>
                      <span className="shrink-0 text-xs text-subtle">{formatDate(e.lastModified, { dateStyle: 'medium', timeStyle: 'short' })}</span>
                    </div>
                    <div className="flex min-w-0 items-center gap-2 text-xs text-subtle">
                      <Badge icon={<Bot className="size-3" aria-hidden />} className="h-4 shrink-0">
                        {e.accountName ? `${e.agentName} · ${e.accountName}` : e.agentName}
                      </Badge>
                      {e.gitBranch && e.gitBranch !== 'HEAD' && (
                        <span className="inline-flex min-w-0 shrink-0 items-center gap-1 font-mono">
                          <GitBranch className="size-3" aria-hidden />
                          <span className="max-w-48 truncate">{e.gitBranch}</span>
                        </span>
                      )}
                      {e.firstPrompt && e.firstPrompt !== e.title && <span className="min-w-0 truncate">{e.firstPrompt}</span>}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
    </Dialog>
  )
}
