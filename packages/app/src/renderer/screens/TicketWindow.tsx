import { ExternalLink, GitPullRequest, SquareTerminal, Sparkles, UserCheck } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { historyForTicket, listedPullRequests, pullRequestsForTicket, sessionsForTicket, type PullRequest, type SessionRef, type TicketDetail, type TicketRef, type TicketTransition } from '@workhub/core'
import type { SessionView } from '@shared/api'
import { Badge, Button, Select, Spinner, StateDot, STATE_TONE, Textarea, TooltipProvider } from '../components/atoms'
import { Markdown, PastSessions, ToastProvider, useToast } from '../components/molecules'
import { I18nProvider, useI18n } from '../i18n/I18nProvider'
import { cn } from '../lib/cn'
import { usePlatform } from '../lib/platform'
import { resolveTheme, usePrefs, useSystemDark } from '../lib/prefs'
import { CATEGORY_TONE, keyProviders, relativeTime, splitLinks } from '../lib/tickets'
import type { TicketsStatus } from '@shared/tickets-api'
import { usePullRequestLists } from '../pullRequestsStore'
import { usePastSessions } from '../lib/usePastSessions'

/** `#/ticket?profile=<id>&key=<KEY>` -> the two ids, or null for any other hash. */
export function parseTicketHash(hash: string): { profileId: string; key: string } | null {
  if (!hash.startsWith('#/ticket')) return null
  const params = new URLSearchParams(hash.split('?')[1] ?? '')
  const profileId = params.get('profile')
  const key = params.get('key')
  return profileId && key ? { profileId, key } : null
}

/** The root of a ticket window: the same providers as the main window, no navigation. */
export function TicketWindowRoot({ profileId, ticketKey }: { profileId: string; ticketKey: string }) {
  return (
    <I18nProvider>
      <TooltipProvider>
        <ThemedToasts>
          <TicketWindow profileId={profileId} ticketKey={ticketKey} />
        </ThemedToasts>
      </TooltipProvider>
    </I18nProvider>
  )
}

function ThemedToasts({ children }: { children: ReactNode }) {
  const { t } = useI18n()
  const { theme } = usePrefs()
  const systemDark = useSystemDark()
  const resolved = resolveTheme(theme, systemDark)
  useEffect(() => {
    window.hub.setTheme(theme)
  }, [theme])
  useEffect(() => {
    document.documentElement.dataset['theme'] = resolved
  }, [resolved])
  return <ToastProvider label={t('common.notifications')}>{children}</ToastProvider>
}

type Load = { state: 'loading' } | { state: 'error'; message: string } | { state: 'missing' } | { state: 'ready'; detail: TicketDetail }

function TicketWindow({ profileId, ticketKey }: { profileId: string; ticketKey: string }) {
  const { t, locale, formatDate } = useI18n()
  const platform = usePlatform()
  const notify = useToast()
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [transitions, setTransitions] = useState<TicketTransition[]>([])
  const [status, setStatus] = useState<TicketsStatus>()
  const [sessions, setSessions] = useState<SessionView[]>([])
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)

  const reload = useCallback(async () => {
    const [detail, moves, st] = await Promise.all([
      window.hub.tickets.get(profileId, ticketKey),
      window.hub.tickets.transitions(profileId, ticketKey),
      window.hub.tickets.status(profileId)
    ])
    setStatus(st)
    if (!detail.ok) setLoad({ state: 'error', message: detail.error })
    else if (!detail.value) setLoad({ state: 'missing' })
    else setLoad({ state: 'ready', detail: detail.value })
    setTransitions(moves.ok ? moves.value : [])
  }, [profileId, ticketKey])

  useEffect(() => {
    document.title = ticketKey
    void reload()
    const off = window.hub.tickets.onChanged(() => void reload())
    return off
  }, [reload, ticketKey])

  useEffect(() => {
    void window.hub.sessions.list().then(setSessions)
    return window.hub.sessions.onChanged((s) => setSessions((list) => (list.some((x) => x.id === s.id) ? list.map((x) => (x.id === s.id ? s : x)) : [...list, s])))
  }, [])

  const providers = useMemo(() => keyProviders(status), [status])
  const sessionRefs: (SessionRef & { view: SessionView })[] = useMemo(() => sessions.map((s) => ({ id: s.id, title: s.label, cwd: s.cwd, view: s })), [sessions])
  const linkedSessions = sessionsForTicket(ticketKey, sessionRefs, providers)
  // Sessions from the History that mention the ticket (title, first prompt, folder or branch), minus the open ones above.
  const past = usePastSessions()
  const pastItems = useMemo(() => historyForTicket(ticketKey, past.entries, providers, past.open).map((entry) => ({ entry })), [ticketKey, past.entries, past.open, providers])
  // The code host's PRs (mine and to review) that name this ticket in their title or branch.
  const { lists: prLists } = usePullRequestLists(profileId)
  const hostPrs = useMemo(() => {
    const byUrl = new Map<string, PullRequest>()
    for (const item of [...(prLists?.mine ?? []), ...(prLists?.toReview ?? [])]) byUrl.set(item.pr.url.toLowerCase(), item.pr)
    return [...byUrl.values()]
  }, [prLists])

  const act = async (op: () => Promise<{ ok: true } | { ok: false; error: string }>, done?: string) => {
    setBusy(true)
    const r = await op()
    setBusy(false)
    if (!r.ok) notify(`${t('ticket.actionError')}: ${r.error}`)
    else if (done) notify(done)
    return r.ok
  }

  const header = (
    <header className={cn('drag-region flex h-12 shrink-0 items-center gap-3 border-b border-border px-4', platform === 'mac' && 'pl-20', platform !== 'mac' && 'pr-36')}>
      <span className="font-mono text-sm font-semibold text-accent">{ticketKey}</span>
      <span className="truncate text-base font-semibold">{load.state === 'ready' ? load.detail.title : ''}</span>
      {load.state === 'ready' && load.detail.url && (
        <Button size="sm" variant="ghost" className="ml-auto" icon={<ExternalLink className="size-3.5" aria-hidden />} onClick={() => void window.hub.tickets.openExternal(load.detail.url!)}>
          {t('tickets.openInBrowser')}
        </Button>
      )}
    </header>
  )

  if (load.state !== 'ready') {
    return (
      <div className="flex h-full flex-col bg-bg">
        {header}
        <div className="flex flex-1 items-center justify-center p-8 text-base text-muted" role={load.state === 'loading' ? 'status' : 'alert'}>
          {load.state === 'loading' && <Spinner className="size-5" label={t('ticket.loading')} />}
          {load.state === 'missing' && t('ticket.notFound', { key: ticketKey })}
          {load.state === 'error' && `${t('ticket.loadError', { key: ticketKey })}: ${load.message}`}
        </div>
      </div>
    )
  }

  const d = load.detail
  const listed = listedPullRequests(d)
  // Linear writes Markdown; Jira's rich text arrives as plain text with hard line breaks.
  const markdown = status?.provider === 'linear'
  // PRs the code host knows open in their own window; other listed URLs open in the browser.
  const matched = pullRequestsForTicket(ticketKey, hostPrs, providers, listed)
  const matchedUrls = new Set(matched.map((pr) => pr.url.toLowerCase()))
  const prs: { url: string; label: string; pr?: PullRequest }[] = [
    ...matched.map((pr) => ({ url: pr.url, label: `${pr.repo}#${pr.number} ${pr.title}`, pr })),
    ...listed.filter((u) => !matchedUrls.has(u.toLowerCase())).map((url) => ({ url, label: url.replace(/^https:\/\/(github\.com|gitlab\.com)\//, '') }))
  ]
  const date = (ms?: number) => (ms ? `${formatDate(ms, { dateStyle: 'medium' })} · ${relativeTime(ms, Date.now(), locale)}` : '—')
  const send = async () => {
    if (await act(() => window.hub.tickets.comment(profileId, ticketKey, comment), t('ticket.commentAdded'))) setComment('')
  }

  return (
    <div className="flex h-full flex-col bg-bg">
      {header}
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_17rem]">
        <main className="min-h-0 overflow-y-auto px-6 py-5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={CATEGORY_TONE[d.category]}>{d.status}</Badge>
            {d.type && <Badge>{d.type}</Badge>}
            {d.labels.map((l) => (
              <Badge key={l} tone="accent">
                {l}
              </Badge>
            ))}
          </div>
          <h1 className="mt-3 text-xl font-semibold tracking-tight">{d.title}</h1>

          <Section title={t('ticket.description')}>
            {d.description ? <RichText text={d.description} markdown={markdown} /> : <p className="text-sm text-subtle">{t('ticket.noDescription')}</p>}
          </Section>

          {(d.parent || d.children.length > 0) && (
            <Section title={d.parent ? t('ticket.parent') : t('ticket.subtasks')}>
              <ul className="flex flex-col gap-1">
                {[...(d.parent ? [d.parent] : []), ...d.children].map((r) => (
                  <RefRow key={r.key} ticketRef={r} onOpen={() => void window.hub.tickets.openWindow(profileId, r.key)} />
                ))}
              </ul>
              {d.parent && d.children.length > 0 && <h3 className="mt-3 mb-1 text-sm font-medium text-muted">{t('ticket.subtasks')}</h3>}
            </Section>
          )}

          <Section title={`${t('ticket.comments')} (${d.comments.length})`}>
            {d.comments.length === 0 ? (
              <p className="text-sm text-subtle">{t('ticket.noComments')}</p>
            ) : (
              <ul className="flex flex-col gap-3">
                {d.comments.map((c) => (
                  <li key={c.id} className="rounded-lg border border-border bg-surface px-3.5 py-2.5">
                    <div className="mb-1 flex items-baseline gap-2 text-sm">
                      <span className="font-medium">{c.author}</span>
                      <span className="text-subtle">{date(c.createdAt)}</span>
                    </div>
                    <RichText text={c.body} markdown={markdown} />
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-3 flex flex-col gap-2">
              <Textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} placeholder={t('ticket.commentPlaceholder')} aria-label={t('ticket.commentPlaceholder')} className="font-sans text-base" />
              <div>
                <Button variant="primary" disabled={busy || !comment.trim()} onClick={() => void send()}>
                  {t('ticket.addComment')}
                </Button>
              </div>
            </div>
          </Section>
        </main>

        <aside className="min-h-0 overflow-y-auto border-l border-border bg-sidebar px-4 py-5">
          <Side title={t('ticket.status')}>
            <Select
              value=""
              aria-label={t('ticket.moveTo')}
              disabled={busy || transitions.length === 0}
              onChange={(id) => id && void act(() => window.hub.tickets.transition(profileId, ticketKey, id))}
              options={[{ value: '', label: t('ticket.moveTo') }, ...transitions.map((m) => ({ value: m.id, label: m.status }))]}
            />
          </Side>
          <Side title={t('ticket.assignee')}>
            <div className="flex items-center justify-between gap-2 text-base">
              <span className="truncate">{d.assignee ?? t('ticket.unassigned')}</span>
              <Button size="sm" variant="ghost" disabled={busy} icon={<UserCheck className="size-3.5" aria-hidden />} onClick={() => void act(() => window.hub.tickets.assignToMe(profileId, ticketKey))}>
                {t('ticket.assignToMe')}
              </Button>
            </div>
          </Side>
          <Side title={t('ticket.details')}>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
              <Detail label={t('ticket.sprint')} value={d.sprint?.name} />
              <Detail label={t('ticket.priority')} value={d.priority} />
              <Detail label={t('ticket.reporter')} value={d.reporter} />
              <Detail label={t('ticket.created')} value={d.createdAt ? relativeTime(d.createdAt, Date.now(), locale) : undefined} />
              <Detail label={t('ticket.updated')} value={d.updatedAt ? relativeTime(d.updatedAt, Date.now(), locale) : undefined} />
            </dl>
          </Side>
          <Side title={t('ticket.pullRequestsTitle')}>
            {prs.length === 0 ? (
              <p className="text-sm text-subtle">{t('ticket.pullRequestsEmpty')}</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {prs.map(({ url, label, pr }) => (
                  <li key={url}>
                    <button
                      type="button"
                      title={url}
                      onClick={() => void (pr ? window.hub.codeHost.openWindow(profileId, url) : window.hub.tickets.openExternal(url))}
                      className="flex w-full items-center gap-1.5 text-left text-sm text-accent hover:underline"
                    >
                      <GitPullRequest className="size-3.5 shrink-0" aria-hidden />
                      <span className="truncate">{label}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Side>
          <Side title={t('ticket.sessionsTitle')}>
            {linkedSessions.length === 0 ? (
              <p className="text-sm text-subtle">{t('ticket.sessionsEmpty')}</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {linkedSessions.map((s) => (
                  <li key={s.id}>
                    <button type="button" onClick={() => window.hub.tickets.openSession(s.id)} title={t('ticket.openSession')} className="flex w-full items-center gap-2 text-left text-sm hover:text-accent">
                      <StateDot tone={STATE_TONE[s.view.state]} />
                      <SquareTerminal className="size-3.5 shrink-0 text-muted" aria-hidden />
                      <span className="truncate">{s.title}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <Button
              size="sm"
              variant="secondary"
              className="mt-2"
              icon={<Sparkles className="size-3.5" aria-hidden />}
              onClick={() => window.hub.links.request({ kind: 'ticketSession', profileId, ticket: { key: ticketKey, title: d.title, url: d.url } })}
            >
              {t('links.ticket.start')}
            </Button>
          </Side>
          <Side title={t('links.pastSessions')}>
            <PastSessions
              items={pastItems}
              loading={past.loading}
              error={past.error}
              className="flex flex-col divide-y divide-border"
              onResume={(entry) => window.hub.links.request({ kind: 'resume', profileId, entry, mode: 'app' })}
            />
          </Side>
        </aside>
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-6">
      <h2 className="mb-2 text-md font-semibold">{title}</h2>
      {children}
    </section>
  )
}

function Side({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-5">
      <h2 className="mb-1.5 text-xs font-semibold tracking-wide text-subtle uppercase">{title}</h2>
      {children}
    </section>
  )
}

function Detail({ label, value }: { label: string; value?: string }) {
  if (!value) return null
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="truncate text-right">{value}</dd>
    </>
  )
}

function RefRow({ ticketRef, onOpen }: { ticketRef: TicketRef; onOpen: () => void }) {
  return (
    <li>
      <button type="button" onClick={onOpen} className="flex w-full items-center gap-3 rounded-md px-2 py-1 text-left text-base hover:bg-surface-hover">
        <span className="w-24 shrink-0 truncate font-mono text-sm text-accent">{ticketRef.key}</span>
        <span className="min-w-0 flex-1 truncate">{ticketRef.title}</span>
        <Badge tone={CATEGORY_TONE[ticketRef.category]}>{ticketRef.status}</Badge>
      </button>
    </li>
  )
}

/** Plain text with its http(s) links made clickable; tracker text is never rendered as HTML. */
function RichText({ text, markdown }: { text: string; markdown: boolean }) {
  return markdown ? <Markdown text={text} className="text-base leading-relaxed" /> : <Linkified text={text} />
}

function Linkified({ text }: { text: string }) {
  return (
    <p className="text-base leading-relaxed whitespace-pre-wrap break-words">
      {splitLinks(text).map((part, i) =>
        part.kind === 'text' ? (
          part.text
        ) : (
          <button key={i} type="button" onClick={() => void window.hub.tickets.openExternal(part.url)} className="text-accent break-all hover:underline">
            {part.url}
          </button>
        )
      )}
    </p>
  )
}
