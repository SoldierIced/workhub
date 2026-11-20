import { Ear, Folder, GitBranch, GitPullRequestCreate, MessagesSquare, MoreHorizontal, Server, Square, SquareTerminal, Terminal as TerminalIcon, UserRound, type LucideIcon } from 'lucide-react'
import { useEffect, useLayoutEffect, useReducer, useRef, useState, type ReactNode } from 'react'
import { sessionIdentity, type LocalChanges } from '@workhub/core'
import type { PullRequestDraftResult } from '@shared/codehost-api'
import type { SessionMode, SessionView } from '@shared/api'
import { AgentIcon, Badge, Button, IconButton, Spinner, STATE_TONE, StateDot, type Tone } from '../../components/atoms'
import { PanelToggleButton } from '../../components/molecules/PanelToggleButton'
import { useSlack } from '../../chatStore'
import { useConfig } from '../../configStore'
import { useI18n } from '../../i18n/I18nProvider'
import type { MessageKey } from '../../i18n/translate'
import { cn } from '../../lib/cn'
import { errorText } from '../../lib/errorText'
import { sessionModePicker } from '../../lib/agent-pickers'
import { MONITOR_SHORTCUT } from '../../lib/nav'
import { changesTotal } from '../../lib/monitorView'
import { readPrefs, setPrefs, usePrefs } from '../../lib/prefs'
import { hasOpenPullRequestFor } from '../../lib/pullRequestFlow'
import { abbreviateFolder, activityOf, changeCounts, foldDensity, formatSince, headerDensity, sessionBranch, type Activity, type HeaderDensity } from '../../lib/sessionHeader'
import { sessionNameInfo } from '../../lib/sessionGroups'
import { useNow } from '../../lib/usage'
import { useAsyncAction } from '../../lib/useAsyncAction'
import { useCachedPullRequestLists } from '../../pullRequestsStore'
import { awaitingAnswer, pushItem, type SessionData } from '../../store'
import { AiReviewButton } from './AiReviewPanel'
import { ContinueMenu } from './ContinueMenu'
import { HeaderButton } from './HeaderButton'
import { LocalReviewButton, SessionFilesMenu } from './SessionReviewTools'
import { SessionTitle } from './SessionTitle'

const MODE_ICON: Record<SessionMode, LucideIcon> = { app: MessagesSquare, console: SquareTerminal, shell: TerminalIcon }
const MODE_LABEL: Record<SessionMode, MessageKey> = { app: 'header.view.app', console: 'session.modeConsole', shell: 'session.modeShell' }

/** The Chat / Terminal / Shell switch, a segmented control with text (icons only on a narrow header). */
export function ModeSwitch({ view: v, iconsOnly }: { view: SessionView; iconsOnly: boolean }) {
  const { t } = useI18n()
  const [pending, setPending] = useState(false)
  const pick = async (mode: SessionMode) => {
    // Picking the view that runs while a switch waits drops the switch.
    if ((mode === v.mode && !v.pendingMode) || pending) return
    setPending(true)
    try {
      await window.hub.sessions.setMode(v.id, mode)
    } catch (e) {
      pushItem(v.id, 'error', errorText(e))
    } finally {
      setPending(false)
    }
  }
  return (
    <div role="radiogroup" aria-label={t('session.mode')} className="inline-flex h-8 shrink-0 items-center rounded-lg border border-border bg-surface-raised p-0.5">
      {v.modes.map((m) => {
        const Icon = MODE_ICON[m]
        const active = v.mode === m
        const waiting = v.pendingMode === m
        return (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={iconsOnly ? t(MODE_LABEL[m]) : undefined}
            disabled={pending}
            onClick={() => void pick(m)}
            data-testid={`mode-${m}`}
            data-pending={waiting || undefined}
            title={waiting ? t('session.switchPending', { mode: t(MODE_LABEL[m]) }) : iconsOnly ? t(MODE_LABEL[m]) : undefined}
            className={cn(
              'inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-sm transition-colors duration-150 disabled:opacity-60',
              active ? 'bg-accent-soft font-semibold text-text' : 'text-muted hover:text-text',
              waiting && 'text-accent ring-1 ring-accent/50'
            )}
          >
            <Icon className="size-3.5" aria-hidden />
            {!iconsOnly && t(MODE_LABEL[m])}
          </button>
        )
      })}
    </div>
  )
}

const ACTIVITY_TONE: Record<Activity, Tone> = { starting: 'warning', working: 'info', stalled: 'warning', needsYou: 'warning', idle: 'success', stopped: 'neutral', error: 'danger' }
/** Activities that are over: their time reads "4 min ago" rather than "4 min". */
const PAST: readonly Activity[] = ['idle', 'stopped', 'error']

/** The state as a badge with its dot and time: "Ready · 4 min ago", "Working · 2 min", counted from when the state began. */
function ActivityPill({ data, now }: { data: SessionData; now: number }) {
  const { t } = useI18n()
  const v = data.view
  const activity = activityOf(v.state, awaitingAnswer(data), v.stalledSince !== undefined)
  // "No output for 12 min" counts from the agent's last event, not from when the turn began.
  const since = activity === 'stalled' ? v.stalledSince! : Math.max(v.stateSince ?? v.startedAt, v.startedAt)
  const elapsed = formatSince(Math.max(now, since) - since)
  const label = t(`header.activity.${activity}`)
  const text = activity === 'stalled' ? `${label} ${elapsed}` : `${label} · ${PAST.includes(activity) ? t('header.ago', { time: elapsed }) : elapsed}`
  return (
    <Badge
      tone={ACTIVITY_TONE[activity]}
      data-testid="session-state"
      data-activity={activity}
      title={activity === 'stalled' ? t('header.stalledHint', { time: elapsed }) : t('header.activityHint', { activity: label, time: elapsed })}
      className="shrink-0 tabular-nums"
      icon={<StateDot tone={activity === 'idle' ? STATE_TONE.ready : ACTIVITY_TONE[activity]} pulse={activity === 'working' || activity === 'starting'} />}
    >
      {text}
    </Badge>
  )
}

/** Opens the monitor's Slack section and brings it into view. */
function revealSlackSection(sessionId: string) {
  const collapsed = readPrefs().monitorCollapsed
  if (collapsed.includes('slack')) setPrefs({ monitorCollapsed: collapsed.filter((s) => s !== 'slack') })
  requestAnimationFrame(() => document.querySelector(`[data-monitor-of="${CSS.escape(sessionId)}"] [data-monitor-section="slack"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }))
}

/** "Listening to 2 Slack threads": shown while threads this session owns are followed; the count only, the sentence on hover. */
function SlackChip({ view, count }: { view: SessionView; count: number }) {
  const { tn, t } = useI18n()
  if (!count) return null
  return (
    <button
      type="button"
      data-testid="session-slack"
      title={`${tn('header.slack', count)}\n${t('header.slackHint')}`}
      aria-label={tn('header.slack', count)}
      onClick={() => revealSlackSection(view.id)}
      className="inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-accent-soft px-2 text-xs font-medium whitespace-nowrap text-accent hover:brightness-110"
    >
      <Ear className="size-3" aria-hidden />
      {count}
    </button>
  )
}

/** The header's "More" menu: whatever did not fit on the row. Stays mounted while open so pickers keep focus. */
function OverflowMenu({ children }: { children: ReactNode }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      // Radix selects render their list in a portal: a click there is still inside the menu.
      const target = e.target as Element
      if (root.current?.contains(target) || target.closest?.('[data-radix-popper-content-wrapper]')) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  return (
    <div ref={root} className="relative shrink-0">
      <IconButton size="sm" label={t('header.more')} aria-haspopup="menu" aria-expanded={open} data-testid="session-more" icon={<MoreHorizontal className="size-4" />} onClick={() => setOpen((o) => !o)} />
      {open && (
        <div role="menu" aria-label={t('header.more')} className="absolute top-full right-0 z-30 mt-1 flex w-72 flex-col items-stretch gap-2 rounded-lg border border-border bg-surface-raised p-2.5 shadow-lg">
          {children}
        </div>
      )}
    </div>
  )
}

/** Measures an element's width, for the header's density. */
function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(1200)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => e && e.contentRect.width > 0 && setWidth(e.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, width]
}

/** Where the monitor's "Create pull request" section is, once the monitor is open and the section unfolded. */
function openCreatePullRequest(sessionId: string) {
  const prefs = readPrefs()
  const patch: Partial<typeof prefs> = {}
  if (prefs.monitorHidden) patch.monitorHidden = false
  if (prefs.monitorCollapsed.includes('newPullRequest')) patch.monitorCollapsed = prefs.monitorCollapsed.filter((s) => s !== 'newPullRequest')
  if (Object.keys(patch).length) setPrefs(patch)
  const monitor = `[data-monitor-of="${CSS.escape(sessionId)}"]`
  // The monitor renders on the next frames after it opens: wait for the section's button, then press it.
  let tries = 0
  const press = () => {
    const open = document.querySelector<HTMLElement>(`${monitor} [data-testid="create-pr-open"]`)
    if (open) open.click()
    else if (++tries < 30) requestAnimationFrame(press)
  }
  requestAnimationFrame(press)
}

export interface SessionBarProps {
  data: SessionData
  /** The session's title (its name, the agent's title, or its first prompt). */
  title: string
  now: number
  /** Slack threads this session owns and follows. */
  slackCount: number
  branch: string | undefined
  /** Lines added and removed, when the app has read them. */
  counts: { additions: number; deletions: number } | undefined
  /** "Create PR" is offered: the branch is pushed, has commits and no open pull request. */
  canCreatePr: boolean
  onCreatePr: () => void
  monitorHidden: boolean
}

/**
 * The session's one-row bar: the agent and the session's title (renamed in place), its state with
 * the time, the branch, then the Chat / Terminal / Shell switch, Changes, Create PR, Stop (only
 * while the agent works), the "More" menu and the monitor toggle. When the row gets narrow it
 * folds level by level (switch to icons, Create PR into the menu, Changes and Stop to icons, the
 * branch into the menu) so it never wraps or draws one thing over another.
 */
export function SessionBar({ data, title, now, slackCount, branch, counts, canCreatePr, onCreatePr, monitorHidden }: SessionBarProps) {
  const { t } = useI18n()
  const v = data.view
  const stop = useAsyncAction(() => window.hub.sessions.stop(v.id))
  const [ref, width] = useWidth<HTMLElement>()
  const identityRef = useRef<HTMLDivElement>(null)
  // Levels folded past the width's density because the row still overflowed at this width.
  const [fold, setFold] = useState({ width: 0, steps: 0 })
  const steps = fold.width === width ? fold.steps : 0
  // Chips that render on their own (Slack, the state's time) change the row without rendering the
  // bar: re-run the overflow check below whenever the identity's content changes.
  const [, recheck] = useReducer((n: number) => n + 1, 0)
  useLayoutEffect(() => {
    const identity = identityRef.current
    if (!identity || typeof MutationObserver === 'undefined') return
    const observer = new MutationObserver(() => recheck())
    observer.observe(identity, { childList: true, subtree: true, characterData: true })
    return () => observer.disconnect()
  }, [])
  const density: HeaderDensity = foldDensity(headerDensity(width), steps)
  // Before paint: if the row does not fit, fold one more level, so items never overlap. A new width
  // starts over from its density.
  useLayoutEffect(() => {
    const header = ref.current
    const identity = identityRef.current
    if (!header || !identity || density === 'narrow') return
    const overflows = identity.scrollWidth > identity.clientWidth + 1 || header.scrollWidth > header.clientWidth + 1
    if (overflows) setFold({ width, steps: steps + 1 })
  })
  const live = v.state === 'ready' || v.state === 'busy' || v.state === 'starting'
  const working = v.state === 'busy' || v.state === 'starting'
  // An agent that owns the modes and offers no picker still shows its current one here.
  const showAgentMode = Boolean(v.currentModeId && v.permissionMode?.id === 'agent-managed' && !sessionModePicker(v).visible)
  const showContinue = live && !v.readOnly && v.modes.includes('app')
  const iconsOnly = density !== 'full'
  const prInline = canCreatePr && (density === 'full' || density === 'icons')
  const tight = density === 'tight' || density === 'narrow'
  const branchInline = branch !== undefined && density !== 'narrow'
  const stopButton = (
    <HeaderButton tone="danger" icon={stop.pending ? <Spinner className="size-3" /> : <Square className="size-3" aria-hidden />} disabled={stop.pending} onClick={() => stop.run()} data-testid="session-stop" aria-label={tight ? t('session.stop') : undefined} title={tight ? t('session.stop') : undefined}>
      {!tight && t('session.stop')}
    </HeaderButton>
  )
  const folder = abbreviateFolder(v.cwd)
  // The WSL distribution the session runs in (`wsl:<distro>`); nothing on this computer.
  const distro = v.hostId?.startsWith('wsl:') ? v.hostId.slice(4) : null

  return (
    <header ref={ref} className="flex h-11 shrink-0 items-center gap-2.5 border-b border-border bg-surface/60 px-4" data-testid="session-header" data-density={density}>
      {/* Clips rather than spills: nothing here is ever drawn under the controls on the right. */}
      <div ref={identityRef} className="flex min-w-0 flex-1 items-center gap-2.5 overflow-hidden text-sm" data-testid="session-identity">
        <AgentIcon agentId={v.agentId} adapter={v.adapter} label={v.agentName} className="size-5" />
        <SessionTitle id={v.id} title={title} name={v.name} tooltip={[title, distro && t('profileHost.sessionTag', { distro }), v.cwd].filter(Boolean).join('\n')} />
        <ActivityPill data={data} now={now} />
        {branchInline && (
          <span className="flex min-w-14 shrink items-center gap-1.5 font-mono text-xs text-subtle" title={branch} data-testid="session-branch">
            <GitBranch className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate">{branch}</span>
          </span>
        )}
        <SlackChip view={v} count={slackCount} />
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {v.modes.length > 1 && <ModeSwitch view={v} iconsOnly={iconsOnly} />}
        <span className="h-[18px] w-px bg-border-strong" aria-hidden />
        {!v.readOnly && <LocalReviewButton sessionId={v.id} compact={tight} counts={counts} />}
        {prInline && (
          <HeaderButton icon={<GitPullRequestCreate className="size-3.5" aria-hidden />} onClick={onCreatePr} data-testid="create-pr-header" title={t('header.createPrHint')}>
            {t('header.createPr')}
          </HeaderButton>
        )}
        {working && stopButton}
        <OverflowMenu>
          <div className="flex flex-col gap-1 text-xs text-muted" data-testid="session-info">
            {v.accountName && (
              <span className="flex items-center gap-1.5" title={t('header.account', { name: v.accountName })} data-testid="session-account">
                <UserRound className="size-3.5 shrink-0" aria-hidden />
                <span className="truncate">{v.accountName}</span>
              </span>
            )}
            {showAgentMode && <span data-testid="session-agent-mode">{t('session.agentMode', { mode: v.currentModeId! })}</span>}
            {branch !== undefined && !branchInline && (
              <span className="flex items-center gap-1.5 font-mono" title={branch}>
                <GitBranch className="size-3.5 shrink-0" aria-hidden />
                <span className="truncate">{branch}</span>
              </span>
            )}
            {distro && (
              <span className="flex items-center gap-1.5" title={t('profileHost.sessionTagHint', { distro })} data-testid="session-host">
                <Server className="size-3.5 shrink-0" aria-hidden />
                <span className="truncate">{t('profileHost.sessionTag', { distro })}</span>
              </span>
            )}
            <span className="flex items-center gap-1.5 font-mono" title={v.cwd} data-testid="session-folder">
              <Folder className="size-3.5 shrink-0" aria-hidden />
              <span className="truncate [direction:rtl]">
                <bdi>{folder}</bdi>
              </span>
            </span>
          </div>
          {canCreatePr && !prInline && (
            <div className="flex flex-wrap items-center gap-1.5 border-t border-border pt-2">
              <Button size="sm" variant="ghost" icon={<GitPullRequestCreate className="size-3.5" aria-hidden />} onClick={onCreatePr} data-testid="create-pr-menu" title={t('header.createPrHint')}>
                {t('header.createPr')}
              </Button>
            </div>
          )}
          {live && (
            <div className="flex flex-wrap items-center gap-1.5 border-t border-border pt-2">
              {!v.readOnly && <SessionFilesMenu data={data} />}
              <AiReviewButton view={v} />
              {showContinue && <ContinueMenu view={v} />}
              {!working && (
                <Button size="sm" variant="ghost" icon={stop.pending ? <Spinner className="size-3" /> : <Square className="size-3" aria-hidden />} disabled={stop.pending} onClick={() => stop.run()} data-testid="session-stop-menu">
                  {t('session.stop')}
                </Button>
              )}
            </div>
          )}
          {!live && !v.readOnly && (
            <div className="flex flex-wrap items-center gap-1.5 border-t border-border pt-2">
              <SessionFilesMenu data={data} />
            </div>
          )}
        </OverflowMenu>
        {/* The side panel (monitor, or the AI review) of every session, folded with ⇧⌘M. */}
        <PanelToggleButton side="right" size="sm" hidden={monitorHidden} shortcut={MONITOR_SHORTCUT} onToggle={() => setPrefs({ monitorHidden: !readPrefs().monitorHidden })} testId="toggle-monitor" />
      </div>
    </header>
  )
}

/** The branch's "Create pull request" draft, read while the session is on screen and again every minute. */
function usePullRequestDraft(view: SessionView, visible: boolean, refreshKey: string) {
  const [draft, setDraft] = useState<PullRequestDraftResult | null>(null)
  const offered = visible && !view.readOnly && view.screens.includes('monitor')
  useEffect(() => {
    if (!offered) return
    let alive = true
    const read = () => void window.hub.codeHost.draftPullRequest(view.id).then((d) => alive && setDraft(d), () => undefined)
    read()
    const timer = setInterval(read, 60_000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [view.id, offered, refreshKey])
  return offered ? draft : null
}

/** The branch's uncommitted changes, read every 30 s while the session is on screen, and again when the folders it worked in change. */
function useLocalChanges(id: string, visible: boolean, workKey: string): LocalChanges | null {
  const [changes, setChanges] = useState<LocalChanges | null>(null)
  useEffect(() => {
    if (!visible) return
    let alive = true
    const read = () => void window.hub.sessions.localChanges(id).then((c) => alive && setChanges(c), () => undefined)
    read()
    const timer = setInterval(read, 30_000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [id, visible, workKey])
  return changes
}

/** The session's header: reads what the bar shows (title, state time, branch, line counts, Create PR) and renders it. */
export function SessionHeader({ data, visible }: { data: SessionData; visible: boolean }) {
  const v = data.view
  const monitorHidden = usePrefs().monitorHidden
  const config = useConfig()
  const profileId = v.profileId ?? config?.config.activeProfileId ?? null
  const lists = useCachedPullRequestLists(profileId)
  const slack = useSlack()
  const identity = sessionIdentity(v)
  const slackCount = slack?.threads.filter((th) => th.owner === identity).length ?? 0
  // Hidden panes stay mounted: only the one on screen ticks.
  const now = useNow(visible ? 15_000 : 600_000)
  const changes = useLocalChanges(v.id, visible && !v.readOnly, data.monitor.changePaths?.join('\n') ?? '')
  const draft = usePullRequestDraft(v, visible, `${v.state}|${data.monitor.pullRequests?.length ?? 0}`)
  const known = [...(lists?.mine ?? []), ...(lists?.toReview ?? [])].map((i) => i.pr)
  const canCreatePr = draft?.state === 'ready' && !hasOpenPullRequestFor(known, draft)
  const total = changes && (changes.touched || !changes.nested) ? changesTotal(changes) : null
  return (
    <SessionBar
      data={data}
      title={sessionNameInfo(data).title}
      now={now}
      slackCount={slackCount}
      branch={sessionBranch(changes, v.worktree?.branch)}
      counts={changeCounts(total)}
      canCreatePr={canCreatePr}
      onCreatePr={() => openCreatePullRequest(v.id)}
      monitorHidden={monitorHidden}
    />
  )
}
