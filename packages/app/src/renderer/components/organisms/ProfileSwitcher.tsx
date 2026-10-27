import { Check, ChevronsUpDown, Settings2 } from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import type { Profile } from '@workhub/core'
import { useI18n } from '../../i18n/I18nProvider'
import { cn } from '../../lib/cn'

export interface ProfileSwitcherProps {
  profiles: Profile[]
  activeId: string | null
  onSelect: (id: string) => void
  onManage: () => void
}

const ITEM = 'flex h-8 cursor-default select-none items-center gap-2 rounded-sm px-2 text-base outline-none data-[highlighted]:bg-accent-soft'

/** Workhub 1's profile card at the top of the sidebar; switching sets the active profile in the config. */
export function ProfileSwitcher({ profiles, activeId, onSelect, onManage }: ProfileSwitcherProps) {
  const { t, tn } = useI18n()
  const active = profiles.find((p) => p.id === activeId)
  const connections = active ? Object.keys(active.connections).length : 0
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        aria-label={t('profile.switch', { name: active?.name ?? t('profile.none') })}
        className="group flex w-full items-center gap-2.5 rounded-lg border border-border bg-surface p-2 text-left shadow-sm transition-colors duration-150 hover:border-border-strong data-[state=open]:border-accent/60"
      >
        <span
          aria-hidden
          className={cn(
            'flex size-8 shrink-0 items-center justify-center rounded-md text-md font-semibold text-white',
            active ? 'brand-gradient' : 'bg-surface-hover text-muted'
          )}
        >
          {(active?.name ?? '?').slice(0, 1).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-semibold">{active?.name ?? t('profile.none')}</span>
          <span className="block truncate text-xs text-muted">
            {active ? tn('profile.connections', connections) : t('profile.noneHint')}
          </span>
        </span>
        <ChevronsUpDown className="size-3.5 text-muted" aria-hidden />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={6}
          className="z-50 w-[var(--radix-dropdown-menu-trigger-width)] animate-fade-in rounded-md border border-border bg-surface-raised p-1 shadow-lg"
        >
          {profiles.length > 0 && (
            <DropdownMenu.Label className="px-2 py-1 text-xs font-medium text-subtle">{t('profile.profiles')}</DropdownMenu.Label>
          )}
          <DropdownMenu.RadioGroup value={activeId ?? ''} onValueChange={onSelect}>
            {profiles.map((p) => (
              <DropdownMenu.RadioItem key={p.id} value={p.id} className={ITEM}>
                <span className="w-4">
                  <DropdownMenu.ItemIndicator>
                    <Check className="size-3.5 text-accent" aria-hidden />
                  </DropdownMenu.ItemIndicator>
                </span>
                <span className="truncate">{p.name}</span>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
          {profiles.length > 0 && <DropdownMenu.Separator className="my-1 h-px bg-border" />}
          <DropdownMenu.Item className={ITEM} onSelect={onManage}>
            <Settings2 className="size-3.5 text-muted" aria-hidden />
            {profiles.length ? t('profile.manage') : t('profile.create')}
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
