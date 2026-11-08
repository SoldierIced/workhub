import { Folder, Play, Star } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { EffectiveAgent } from '@workhub/core'
import type { WorkspaceFolder } from '../../shared/api'
import { Spinner } from '../../renderer/components/atoms'
import { useI18n } from '../../renderer/i18n/I18nProvider'
import { cn } from '../../renderer/lib/cn'
import { useSessions } from '../../renderer/store'
import { navigate, useClientStatus, useConfig, useProfileId, useRemoteData } from '../app-context'
import { queueFirstPrompt } from '../first-prompt'
import { basename, Body, Header, Screen, BigButton } from '../ui'

/** Opens a session on the desktop in one of the profile's folders, with an optional first message. */
export function NewSessionScreen() {
  const { t } = useI18n()
  const status = useClientStatus()
  const { config } = useConfig()
  const [profileId, setProfileId] = useProfileId(config)
  const sessions = useSessions()
  const folders = useRemoteData<WorkspaceFolder[]>('hub:profileFolders', [profileId], () => window.hub.profileFolders(profileId), [profileId])
  const agents = useRemoteData<EffectiveAgent[]>('config:effectiveAgents', [profileId], () => window.hub.config.effectiveAgents(profileId), [profileId])
  const [cwd, setCwd] = useState<string | null>(null)
  const [agentKey, setAgentKey] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const folderList = useMemo(() => {
    const all = folders.data ?? []
    // Profile roots first, then the repositories inside them, in the desktop's order.
    return [...all.filter((f) => f.root), ...all.filter((f) => !f.root)]
  }, [folders.data])
  const agentList = useMemo(() => (agents.data ?? []).filter((a) => a.agent.adapter !== 'terminal' || a.agent.id !== 'shell'), [agents.data])

  useEffect(() => {
    if (cwd && !folderList.some((f) => f.path === cwd)) setCwd(null)
    if (!cwd && folderList[0]) setCwd(folderList[0].path)
  }, [folderList, cwd])
  useEffect(() => {
    if (agentKey && !agentList.some((a) => a.key === agentKey)) setAgentKey(null)
    if (!agentKey && agentList[0]) setAgentKey(agentList[0].key)
  }, [agentList, agentKey])

  const openCount = (path: string) => Object.values(sessions).filter((s) => s.view.cwd === path).length
  const profiles = config?.config.profiles ?? []
  const profile = profiles.find((p) => p.id === profileId)
  const canStart = status.state === 'online' && !!cwd && !!agentKey && !starting

  const start = async () => {
    if (!cwd || !agentKey) return
    setStarting(true)
    setError(null)
    try {
      const view = await window.hub.sessions.start({ profileId, agentKey, cwd, mode: 'app' })
      if (text.trim()) queueFirstPrompt(view.id, text.trim())
      navigate({ screen: 'session', id: view.id }, true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setStarting(false)
    }
  }

  return (
    <Screen>
      <Header
        title={t('web.new.title')}
        back
        right={
          profiles.length > 1 ? (
            <select value={profileId ?? ''} onChange={(e) => setProfileId(e.target.value || null)} aria-label={t('web.new.profile')} className="h-9 max-w-36 rounded-full border border-border-strong bg-surface px-3 text-sm text-text">
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          ) : profile ? (
            <span className="flex h-9 items-center gap-2 rounded-full border border-border-strong bg-surface px-3 text-sm">
              {profile.color && <span className="size-2.5 rounded-sm" style={{ background: profile.color }} aria-hidden />}
              {profile.name}
            </span>
          ) : null
        }
      />
      <Body className="flex flex-col gap-5 px-5 py-4">
        <section className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold text-muted">{t('web.new.folder')}</h2>
            <span className="text-2xs text-subtle">{t('web.new.folderHint')}</span>
          </div>
          {folders.loading && !folders.data ? (
            <Spinner className="size-5 self-center" />
          ) : folderList.length === 0 ? (
            <p className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-muted">{t('web.new.noFolders')}</p>
          ) : (
            <div role="radiogroup" aria-label={t('web.new.folder')} className="flex flex-col gap-1.5">
              {folderList.map((f) => {
                const on = f.path === cwd
                const open = openCount(f.path)
                return (
                  <button
                    key={f.path}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => setCwd(f.path)}
                    className={cn('flex min-h-12 items-center gap-2.5 rounded-xl border px-3 text-left', on ? 'border-accent bg-accent/8' : 'border-border bg-surface')}
                  >
                    {f.root ? <Star className="size-4 shrink-0 fill-warning text-warning" aria-hidden /> : <Folder className="size-4 shrink-0 text-subtle" aria-hidden />}
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-md font-medium">{f.name || basename(f.path)}</span>
                      <span className="truncate font-mono text-2xs text-muted">{f.path}</span>
                    </span>
                    {open > 0 && <span className="ml-auto shrink-0 text-2xs text-accent">{open}</span>}
                  </button>
                )
              })}
            </div>
          )}
        </section>

        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-muted">{t('web.new.agent')}</h2>
          <div role="radiogroup" aria-label={t('web.new.agent')} className="grid grid-cols-2 gap-1.5">
            {agentList.map((a) => {
              const on = a.key === agentKey
              return (
                <button key={a.key} type="button" role="radio" aria-checked={on} onClick={() => setAgentKey(a.key)} className={cn('flex min-h-13 flex-col items-start justify-center gap-0.5 rounded-xl border px-3 py-2 text-left', on ? 'border-accent bg-accent/8' : 'border-border bg-surface')}>
                  <span className="text-sm font-semibold">{a.agent.name}</span>
                  {a.account && <span className="truncate text-2xs text-muted">{a.account.name}</span>}
                </button>
              )
            })}
          </div>
        </section>

        <section className="flex flex-col gap-2">
          <label htmlFor="first-prompt" className="text-sm font-semibold text-muted">
            {t('web.new.firstMessage')} <span className="font-normal text-subtle">{t('web.new.optional')}</span>
          </label>
          <textarea id="first-prompt" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder={t('web.new.firstPlaceholder')} className="resize-none rounded-xl border border-border-strong bg-surface px-3.5 py-3 text-md text-text" />
        </section>
        {error && <p className="text-sm text-danger">{t('web.new.failed', { error })}</p>}
      </Body>
      <div className="safe-bottom shrink-0 border-t border-border bg-sidebar px-5 pt-3 pb-3">
        <BigButton onClick={() => void start()} disabled={!canStart}>
          {starting ? <Spinner className="size-4" /> : <Play className="size-4" aria-hidden />}
          {starting ? t('web.new.starting') : t('web.new.start', { desktop: status.desktop?.name ?? '' })}
        </BigButton>
        <p className="mt-2 text-center text-xs text-subtle">{t('web.new.hint')}</p>
      </div>
    </Screen>
  )
}
