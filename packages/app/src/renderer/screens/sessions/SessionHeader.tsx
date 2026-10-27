import { Cpu, Ear, Folder, MessagesSquare, MoreHorizontal, Shield, ShieldAlert, Square, SquareTerminal, Terminal as TerminalIcon, UserRound, type LucideIcon } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { effectiveAgentKey, sessionIdentity } from '@workhub/core'
import type { SessionMode, SessionView } from '@shared/api'
import { Badge, Button, IconButton, Select, STATE_TONE, StateDot, type Tone } from '../../components/atoms'
import { useSlack } from '../../chatStore'
import { useI18n } from '../../i18n/I18nProvider'
import type { MessageKey } from '../../i18n/translate'
import { cn } from '../../lib/cn'
import { errorText } from '../../lib/errorText'
import { sessionModelPicker, sessionModePicker } from '../../lib/agent-pickers'
import { readPrefs, rememberMode, rememberModel, setPrefs } from '../../lib/prefs'
import { abbreviateFolder, activityElapsed, activityOf, foldDensity, headerDensity, isClockActivity, permissionModeLabel, type Activity, type HeaderDensity } from '../../lib/sessionHeader'
import { useNow } from '../../lib/usage'
import { awaitingAnswer, pushItem, type SessionData } from '../../store'
import { AiReviewButton } from './AiReviewPanel'
import { ContinueMenu } from './ContinueMenu'
import { SessionReviewTools } from './SessionReviewTools'

const MODE_ICON: Record<SessionMode, LucideIcon> = { app: MessagesSquare, console: SquareTerminal, shell: TerminalIcon }
const MODE_LABEL: Record<SessionMode, MessageKey> = { app: 'session.modeApp', console: 'session.modeConsole', shell: 'session.modeShell' }

/** Workhub 1's App / Terminal / Shell switch; icons only on a narrow header. */
function ModeSwitch({ view: v, iconsOnly }: { view: SessionView; iconsOnly: boolean }) {
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
    <div role="radiogroup" aria-label={t('session.mode')} className="inline-flex h-7 shrink-0 items-center rounded-md border border-border bg-surface p-0.5">
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
              'inline-flex h-6 items-center gap-1.5 rounded px-2 text-sm transition-colors duration-150 disabled:opacity-60',
              active ? 'bg-accent-soft font-medium text-text' : 'text-muted hover:text-text',
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

/** The current option's name, for an icon-only picker's tooltip. */
function optionName(options: readonly { value: string; label: string }[], value: string, fallback: string): string {
  return options.find((o) => o.value === value)?.label ?? fallback
}

function ModelPicker({ view: v, wide, compact }: { view: SessionView; wide?: boolean; compact?: boolean }) {
  const { t } = useI18n()
  const picker = sessionModelPicker(v)
  const change = (id: string) => {
    rememberModel(effectiveAgentKey(v.agentId, v.accountId), id || null)
    void window.hub.sessions.setModel(v.id, id || null).catch((e: unknown) => pushItem(v.id, 'error', errorText(e)))
  }
  const options = [...(picker.allowDefault ? [{ value: '', label: t('session.modelDefault') }] : []), ...picker.options]
  const name = `${t('session.model')}: ${optionName(options, picker.value, t('session.modelDefault'))}`
  return (
    <span data-testid="model-picker" title={v.modelIgnored ? t('agentControls.modelIgnored') : undefined}>
      <Select
        aria-label={t('session.model')}
        value={picker.value}
        onChange={change}
        disabled={picker.disabled}
        options={options}
        compact={compact ? { icon: <Cpu className="size-3.5 shrink-0 text-muted" aria-hidden />, title: v.modelIgnored ? `${name}\n${t('agentControls.modelIgnored')}` : name } : undefined}
        className={cn('h-7 text-sm', wide ? 'w-full!' : compact ? 'w-auto! gap-1 px-1.5' : 'w-40!')}
      />
    </span>
  )
}

/** The session's agent (Kiro, OpenCode) or permission preset (Codex, Gemini), switched live over ACP. */
function ModePicker({ view: v, wide, compact }: { view: SessionView; wide?: boolean; compact?: boolean }) {
  const { t } = useI18n()
  const picker = sessionModePicker(v)
  const change = (id: string) => {
    if (!id) return
    rememberMode(effectiveAgentKey(v.agentId, v.accountId), id)
    void window.hub.sessions.setAgentMode(v.id, id).catch((e: unknown) => pushItem(v.id, 'error', errorText(e)))
  }
  const label = t(picker.kind === 'agent' ? 'agentControls.agent' : 'agentControls.permission')
  const hint = v.modeIgnored ? t('agentControls.modeIgnored') : t(picker.kind === 'agent' ? 'agentControls.agentHint' : 'agentControls.permissionHint')
  const Icon = picker.kind === 'agent' ? UserRound : Shield
  return (
    <span data-testid="mode-picker" className={cn('inline-flex items-center gap-1 text-xs text-muted', wide && 'w-full')} title={compact ? undefined : hint}>
      {picker.kind === 'agent' && !compact && <UserRound className="size-3.5 shrink-0" aria-hidden />}
      <Select
        aria-label={label}
        value={picker.value}
        onChange={change}
        disabled={picker.disabled}
        options={picker.options}
        placeholder={label}
        compact={compact ? { icon: <Icon className="size-3.5 shrink-0 text-muted" aria-hidden />, title: `${label}: ${optionName(picker.options, picker.value, label)}\n${hint}` } : undefined}
        className={cn('h-7 text-sm', wide ? 'w-full!' : compact ? 'w-auto! gap-1 px-1.5' : 'w-36!')}
      />
    </span>
  )
}

const ACTIVITY_TONE: Record<Activity, Tone> = { starting: 'warning', working: 'info', needsYou: 'warning', idle: 'neutral', stopped: 'neutral', error: 'danger' }

/** Workhub 1's activity capsule: "Working 1:23", "Idle 2 min", counted from when the state began. */
function ActivityPill({ data, visible }: { data: SessionData; visible: boolean }) {
  const { t } = useI18n()
  const v = data.view
  const activity = activityOf(v.state, awaitingAnswer(data))
  // Hidden panes stay mounted: only the one on screen ticks every second.
  const now = useNow(visible ? (isClockActivity(activity) ? 1000 : 15_000) : 600_000)
  const since = Math.max(v.stateSince ?? v.startedAt, v.startedAt)
  const elapsed = activityElapsed(activity, since, Math.max(now, since))
  const label = t(`header.activity.${activity}`)
  return (
    <Badge
      tone={ACTIVITY_TONE[activity]}
      data-testid="session-state"
      data-activity={activity}
      title={t('header.activityHint', { activity: label, time: elapsed })}
      className="shrink-0 tabular-nums"
      icon={<StateDot tone={activity === 'idle' ? STATE_TONE.ready : ACTIVITY_TONE[activity]} pulse={activity === 'working' || activity === 'starting'} />}
    >
      {label}
      <span className="opacity-70">{elapsed}</span>
    </Badge>
  )
}

/** Opens the monitor's Slack section and brings it into view. */
function revealSlackSection(sessionId: string) {
  const collapsed = readPrefs().monitorCollapsed
  if (collapsed.includes('slack')) setPrefs({ monitorCollapsed: collapsed.filter((s) => s !== 'slack') })
  requestAnimationFrame(() => document.querySelector(`[data-monitor-of="${CSS.escape(sessionId)}"] [data-monitor-section="slack"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }))
}

/** "Listening to 2 Slack threads": shown while threads this session owns are followed. */
function SlackChip({ view }: { view: SessionView }) {
  const { tn, t } = useI18n()
  const snap = useSlack()
  const identity = sessionIdentity(view)
  const count = snap?.threads.filter((th) => th.owner === identity).length ?? 0
  if (!count) return null
  return (
    <button
      type="button"
      data-testid="session-slack"
      title={t('header.slackHint')}
      onClick={() => revealSlackSection(view.id)}
      className="inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-accent-soft px-2 text-xs font-medium whitespace-nowrap text-accent hover:brightness-110"
    >
      <Ear className="size-3" aria-hidden />
      {tn('header.slack', count)}
    </button>
  )
}

/**
 * The permission mode. On the row it shows the mode's name only ("Bypass permissions"), with the
 * full "Permission mode: …" and its source on hover; in the "More" menu (`full`) it spells it out.
 */
function PermissionChip({ view: v, full }: { view: SessionView; full?: boolean }) {
  const { t } = useI18n()
  const mode = v.permissionMode
  const name = mode ? permissionModeLabel(mode, v.currentModeId, t) : v.state === 'starting' ? t('session.pending') : t('session.unknown')
  const text = t('session.permissionMode', { mode: name })
  return (
    <Badge
      tone={mode?.unattended ? 'warning' : 'neutral'}
      data-testid="permission-mode"
      aria-label={text}
      title={mode ? `${text}\n${t('session.permissionSource', { source: mode.source })}` : text}
      icon={mode?.unattended ? <ShieldAlert className="size-3 shrink-0" aria-hidden /> : undefined}
      className={cn('min-w-0', full ? 'max-w-full' : 'max-w-44 shrink-0')}
    >
      <span className="truncate">{full ? text : name}</span>
    </Badge>
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

/**
 * The session's one-row header (Workhub 1's ConsoleStatusBar): agent, account, folder in short,
 * activity with its timer, Slack, then the controls. Secondary controls fold into "More" when the
 * row gets narrow, so it never wraps.
 */
export function SessionHeader({ data, visible }: { data: SessionData; visible: boolean }) {
  const { t } = useI18n()
  const v = data.view
  const [ref, width] = useWidth<HTMLElement>()
  const identityRef = useRef<HTMLDivElement>(null)
  // Levels folded past the width's density because the row still overflowed at this width.
  const [fold, setFold] = useState({ width: 0, steps: 0 })
  const steps = fold.width === width ? fold.steps : 0
  const density: HeaderDensity = foldDensity(headerDensity(width), steps)
  // Before paint: if the row does not fit (long labels, an account name, many controls), fold one
  // more level into "More", so items never overlap. A new width starts over from its density.
  useLayoutEffect(() => {
    const header = ref.current
    const identity = identityRef.current
    if (!header || !identity || density === 'narrow') return
    const overflows = identity.scrollWidth > identity.clientWidth + 1 || header.scrollWidth > header.clientWidth + 1
    if (overflows) setFold({ width, steps: steps + 1 })
  })
  const live = v.state === 'ready' || v.state === 'busy' || v.state === 'starting'
  const showModePicker = sessionModePicker(v).visible
  const showModelPicker = sessionModelPicker(v).visible
  const showAgentMode = Boolean(v.currentModeId && v.permissionMode?.id === 'agent-managed' && !showModePicker)
  const showContinue = live && !v.readOnly && v.modes.includes('app')
  const unattended = v.permissionMode?.unattended === true

  // Below `full` the pickers and actions keep their icon only; then, level by level, the chips,
  // the actions and the pickers fold into "More".
  const iconControls = density !== 'full'
  const chipsInline = density === 'full' || density === 'icons'
  const actionsInline = chipsInline || density === 'compact'
  const controlsInline = density !== 'narrow'
  const agentMode = showAgentMode && <Badge className="shrink-0">{t('session.agentMode', { mode: v.currentModeId! })}</Badge>
  const overflow = (
    <>
      {!controlsInline && showModePicker && <ModePicker view={v} wide />}
      {!controlsInline && showModelPicker && <ModelPicker view={v} wide />}
      {!chipsInline && (
        <div className="flex flex-wrap items-center gap-1.5">
          <PermissionChip view={v} full />
          {agentMode}
        </div>
      )}
      {!actionsInline && !v.readOnly && (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-border pt-2">
          <SessionReviewTools data={data} />
        </div>
      )}
      {!actionsInline && live && (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-border pt-2">
          <AiReviewButton view={v} />
          {showContinue && <ContinueMenu view={v} />}
        </div>
      )}
    </>
  )
  const hasOverflow = !chipsInline || (!actionsInline && (live || !v.readOnly)) || (!controlsInline && (showModePicker || showModelPicker))

  return (
    <header ref={ref} className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-surface/60 px-4" data-testid="session-header" data-density={density}>
      {/* Clips rather than spills: nothing here is ever drawn under the controls on the right. */}
      <div ref={identityRef} className={cn('flex min-w-0 flex-1 items-center overflow-hidden text-sm', iconControls ? 'gap-2' : 'gap-2.5')} data-testid="session-identity">
        <SquareTerminal className="size-4 shrink-0 text-accent" aria-hidden />
        <h1 className={cn('max-w-48 truncate font-semibold', density === 'narrow' ? 'min-w-12 shrink' : 'shrink-0')} title={v.agentName}>
          {v.agentName}
        </h1>
        {v.accountName && (
          <Badge tone="accent" data-testid="session-account" className={cn('shrink', iconControls ? 'max-w-28' : 'max-w-36')} title={t('header.account', { name: v.accountName })} icon={<UserRound className="size-3 shrink-0" aria-hidden />}>
            <span className="truncate">{v.accountName}</span>
          </Badge>
        )}
        <ActivityPill data={data} visible={visible} />
        <span className={cn('flex shrink items-center gap-1 text-xs text-subtle', density === 'narrow' ? 'min-w-0' : 'min-w-16')} title={v.cwd} data-testid="session-folder">
          <Folder className="size-3.5 shrink-0" aria-hidden />
          {/* Truncates from the start, so the folder's own name stays readable. */}
          <span className="truncate font-mono [direction:rtl]">
            <bdi>{abbreviateFolder(v.cwd)}</bdi>
          </span>
        </span>
        <SlackChip view={v} />
        {unattended && !chipsInline && (
          <span className="shrink-0 text-warning" title={v.permissionMode ? permissionModeLabel(v.permissionMode, v.currentModeId, t) : undefined}>
            <ShieldAlert className="size-3.5" aria-label={t('session.permissionMode', { mode: v.permissionMode ? permissionModeLabel(v.permissionMode, v.currentModeId, t) : '' })} />
          </span>
        )}
      </div>
      <div className={cn('flex shrink-0 items-center', iconControls ? 'gap-1' : 'gap-1.5')}>
        {chipsInline && <PermissionChip view={v} />}
        {chipsInline && agentMode}
        {v.modes.length > 1 && <ModeSwitch view={v} iconsOnly={iconControls} />}
        {controlsInline && showModePicker && <ModePicker view={v} compact={iconControls} />}
        {controlsInline && showModelPicker && <ModelPicker view={v} compact={iconControls} />}
        {actionsInline && <SessionReviewTools data={data} compact={iconControls} />}
        {actionsInline && live && <AiReviewButton view={v} compact={iconControls} />}
        {actionsInline && showContinue && <ContinueMenu view={v} compact={iconControls} />}
        {live && (
          <Button size="sm" variant="ghost" icon={<Square className="size-3" aria-hidden />} onClick={() => void window.hub.sessions.stop(v.id)}>
            {t('session.stop')}
          </Button>
        )}
        {hasOverflow && <OverflowMenu>{overflow}</OverflowMenu>}
      </div>
    </header>
  )
}
