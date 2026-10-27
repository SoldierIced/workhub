import type { CSSProperties } from 'react'
import { Bot, SquareTerminal } from 'lucide-react'
import { cn } from '../../lib/cn'
import { AgentLogo, LOGO_AGENTS } from './AgentLogos'
import { agentGlyph, type AgentGlyph } from '../../lib/agents'

/** Monogram badges for agents without a logo. Same fill in both themes; white text keeps the contrast. */
const BADGE: Record<'opencode' | 'gemini', { text: string; className: string }> = {
  opencode: { text: 'Oc', className: 'bg-[#3b6fd4]' },
  gemini: { text: 'G', className: 'bg-[#b8497f]' }
}

export interface AgentIconProps {
  /** The agent's id (or its `agent:account` key). */
  agentId: string
  /** The agent's adapter: a terminal agent gets the shell mark. */
  adapter?: string
  /** The accessible name (the agent's name). Without one the icon is decorative. */
  label?: string
  className?: string
  /** Inline style, such as the ring colour of the account the session runs with. */
  style?: CSSProperties
}

/** A small mark that tells which agent runs a session: the official logo for Claude, Codex and Kiro, a monogram for the other known agents, a terminal for shells, a bot for the rest. */
export function AgentIcon({ agentId, adapter, label, className, style }: AgentIconProps) {
  const glyph = agentGlyph(agentId, adapter)
  const a11y = label ? { role: 'img' as const, 'aria-label': label } : { 'aria-hidden': true }
  const base = 'inline-flex size-5 shrink-0 select-none items-center justify-center rounded-md'
  if (glyph === 'shell' || glyph === 'generic') {
    const Icon = glyph === 'shell' ? SquareTerminal : Bot
    return (
      <span {...a11y} data-agent-icon={glyph} style={style} className={cn(base, 'bg-surface-hover text-muted ring-1 ring-border ring-inset', className)}>
        <Icon className="size-3" aria-hidden />
      </span>
    )
  }
  if (LOGO_AGENTS.has(glyph)) {
    const kiro = glyph === 'kiro'
    return (
      <span {...a11y} data-agent-icon={glyph} data-agent-logo={glyph} style={style} className={cn(base, kiro ? 'bg-[#9046ff]' : 'bg-surface-hover text-text ring-1 ring-border ring-inset', className)}>
        <AgentLogo agent={glyph as 'claude' | 'codex' | 'kiro'} />
      </span>
    )
  }
  const badge = BADGE[glyph as 'opencode' | 'gemini']
  return (
    <span {...a11y} data-agent-icon={glyph} style={style} className={cn(base, 'font-semibold text-white', badge.className, badge.text.length > 1 ? 'text-[9px] tracking-tighter' : 'text-xs', className)}>
      <span aria-hidden>{badge.text}</span>
    </span>
  )
}
