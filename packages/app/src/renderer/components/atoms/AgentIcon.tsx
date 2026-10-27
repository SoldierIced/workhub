import type { CSSProperties } from 'react'
import { Bot, SquareTerminal } from 'lucide-react'
import { cn } from '../../lib/cn'
import { agentGlyph, type AgentGlyph } from '../../lib/agents'

/** Monogram badges: original marks, no brand logos. Same fill in both themes; white text keeps the contrast. */
const BADGE: Record<Exclude<AgentGlyph, 'shell' | 'generic'>, { text: string; className: string }> = {
  claude: { text: 'C', className: 'bg-[#c2603f]' },
  kiro: { text: 'K', className: 'bg-[#7c5cd6]' },
  codex: { text: 'Cx', className: 'bg-[#1f8a70]' },
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

/** A small mark that tells which agent runs a session: a monogram per known agent, a terminal for shells, a bot for the rest. */
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
  const badge = BADGE[glyph]
  return (
    <span {...a11y} data-agent-icon={glyph} style={style} className={cn(base, 'font-semibold text-white', badge.className, badge.text.length > 1 ? 'text-[9px] tracking-tighter' : 'text-xs', className)}>
      <span aria-hidden>{badge.text}</span>
    </span>
  )
}
