import type { ReactNode } from 'react'
import { AgentIcon } from '../atoms/AgentIcon'
import { ChevronDown, Plus, Settings } from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import type { EffectiveAgent } from '@workhub/core'
import { useI18n } from '../../i18n/I18nProvider'
import { cn } from '../../lib/cn'
import { NEW_SESSION_SHORTCUT, SETTINGS_ITEM } from '../../lib/nav'
import { usePlatform } from '../../lib/platform'
import { shortcutLabel } from '../../lib/shortcuts'
import { IconButton } from '../atoms/IconButton'
import { Kbd } from '../atoms/Kbd'

export interface ToolbarProps {
  /** The screens (TopNav), on the left. */
  nav: ReactNode
  agents: EffectiveAgent[]
  /** The button: starts the profile's preferred agent in its default folder without asking. */
  onNewSession: () => void
  /** The arrow's items: the new session dialog, with that agent picked (none: the profile's first). */
  onChooseSession: (agentKey?: string) => void
  /** What the button starts, e.g. "New Claude session in ~/acme". */
  newSessionHint?: string
  onOpenSettings: () => void
}

/**
 * The window's top bar over the content: the screens on the left, a new session and Settings on
 * the right. It drags the window; on Windows and Linux the native
 * window controls are drawn over its right end (titleBarOverlay), so it leaves room for them.
 */
export function Toolbar({ nav, agents, onNewSession, onChooseSession, newSessionHint, onOpenSettings }: ToolbarProps) {
  const { t } = useI18n()
  const platform = usePlatform()
  return (
    <header className={cn('drag-region flex h-12 shrink-0 items-center gap-2 border-b border-border px-4', platform !== 'mac' && 'pr-36')}>
      {nav}
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <div className="flex items-center rounded-md shadow-sm">
          <button
            type="button"
            onClick={() => onNewSession()}
            title={newSessionHint ? `${newSessionHint} (${shortcutLabel(NEW_SESSION_SHORTCUT, platform)})` : shortcutLabel(NEW_SESSION_SHORTCUT, platform)}
            data-testid="toolbar-new-session"
            aria-label={t('toolbar.newSession')}
            className="inline-flex h-7 items-center gap-1 rounded-l-md bg-accent pr-2.5 pl-2 text-sm font-semibold text-accent-fg transition-colors duration-150 hover:bg-accent-strong"
          >
            <Plus className="size-3.5" aria-hidden />
            {t('toolbar.newSessionShort')}
          </button>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger
              aria-label={t('toolbar.chooseAgent')}
              className="inline-flex h-7 items-center rounded-r-md border-l border-black/15 bg-accent px-1 text-accent-fg transition-colors duration-150 hover:bg-accent-strong"
            >
              <ChevronDown className="size-3.5" aria-hidden />
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content align="end" sideOffset={6} className="z-50 min-w-56 animate-fade-in rounded-md border border-border bg-surface-raised p-1 shadow-lg">
                <DropdownMenu.Label className="px-2 py-1 text-xs font-medium text-subtle">{t('toolbar.newSessionWith')}</DropdownMenu.Label>
                {agents.length === 0 && <div className="px-2 py-1.5 text-sm text-muted">{t('session.noAgents')}</div>}
                {agents.map((a) => (
                  <DropdownMenu.Item
                    key={a.key}
                    onSelect={() => onChooseSession(a.key)}
                    className="flex h-8 cursor-default select-none items-center gap-2 rounded-sm px-2 text-base outline-none data-[highlighted]:bg-accent-soft"
                  >
                    <AgentIcon agentId={a.agent.id} adapter={a.agent.adapter} />
                    {a.label}
                  </DropdownMenu.Item>
                ))}
                <DropdownMenu.Separator className="my-1 h-px bg-border" />
                <DropdownMenu.Item
                  onSelect={() => onChooseSession()}
                  data-testid="toolbar-choose-session"
                  className="flex h-8 cursor-default select-none items-center gap-2 rounded-sm px-2 text-base outline-none data-[highlighted]:bg-accent-soft"
                >
                  {t('toolbar.moreOptions')}
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
        <IconButton label={t('nav.settings')} hint={<Kbd shortcut={SETTINGS_ITEM.shortcut} />} icon={<Settings className="size-4" />} onClick={onOpenSettings} />
      </div>
    </header>
  )
}
