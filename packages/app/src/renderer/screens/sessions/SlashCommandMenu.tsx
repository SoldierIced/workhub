import { Fragment, useEffect, useRef } from 'react'
import type { SlashCommandInfo } from '@workhub/core'
import { useI18n } from '../../i18n/I18nProvider'
import { cn } from '../../lib/cn'

/** The option's element id, for the composer's `aria-activedescendant`. */
export const slashOptionId = (sessionId: string, index: number) => `slash-${sessionId}-${index}`

/**
 * The composer's `/` menu (Workhub 1's command completions): the commands that match what is typed,
 * grouped Workhub / agent / skills, each with its argument hint and description. The keys are the
 * composer's (arrows, Enter, Tab, Esc); a click picks an entry.
 */
export function SlashCommandMenu({
  sessionId,
  agentName,
  commands,
  selected,
  onPick,
  onHover
}: {
  sessionId: string
  agentName: string
  commands: readonly SlashCommandInfo[]
  selected: number
  onPick: (command: SlashCommandInfo) => void
  onHover: (index: number) => void
}) {
  const { t } = useI18n()
  const list = useRef<HTMLUListElement>(null)
  useEffect(() => {
    list.current?.querySelector(`#${CSS.escape(slashOptionId(sessionId, selected))}`)?.scrollIntoView({ block: 'nearest' })
  }, [sessionId, selected])
  const groupTitle = (group: SlashCommandInfo['group']) =>
    group === 'workhub' ? t('slash.group.workhub') : group === 'agent' ? t('slash.group.agent', { agent: agentName }) : t('slash.group.skill')
  return (
    <ul
      ref={list}
      id={`slash-${sessionId}`}
      role="listbox"
      aria-label={t('slash.menu')}
      data-testid="slash-menu"
      className="mx-2 mt-2 max-h-64 overflow-y-auto rounded-lg border border-border bg-surface-raised p-1 text-sm shadow-md"
    >
      {commands.map((c, i) => (
        <Fragment key={`${c.group}:${c.name}`}>
          {(i === 0 || commands[i - 1]!.group !== c.group) && (
            <li role="presentation" className="px-2 pt-1.5 pb-0.5 text-2xs font-medium tracking-wide text-subtle uppercase">
              {groupTitle(c.group)}
            </li>
          )}
          <li
            id={slashOptionId(sessionId, i)}
            role="option"
            aria-selected={i === selected}
            data-testid="slash-option"
            // Picking keeps the focus in the composer.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(c)}
            onMouseMove={() => i !== selected && onHover(i)}
            className={cn('flex cursor-pointer items-baseline gap-2 rounded-md px-2 py-1', i === selected && 'bg-accent-soft')}
          >
            <span className="shrink-0 font-semibold text-text">/{c.name}</span>
            {c.argumentHint && <span className="shrink-0 text-xs text-subtle">{c.argumentHint}</span>}
            {c.description && <span className="min-w-0 truncate text-xs text-muted">{c.description}</span>}
          </li>
        </Fragment>
      ))}
    </ul>
  )
}
