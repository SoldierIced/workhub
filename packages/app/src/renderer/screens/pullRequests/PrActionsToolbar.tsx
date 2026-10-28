import { MoreHorizontal } from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Button, IconButton } from '../../components/atoms'
import { useI18n } from '../../i18n/I18nProvider'
import { cn } from '../../lib/cn'

export interface PrToolbarAction {
  key: string
  label: string
  icon: ReactNode
  variant: 'primary' | 'secondary' | 'danger'
  title?: string
  disabled?: boolean
  onSelect: () => void
  /** Which side of the row it sits on. */
  side: 'start' | 'end'
  /**
   * When it folds into "More" as the row gets narrow: lower folds first. `menu` keeps it there at
   * every width (rare, destructive actions); without a value it never folds.
   */
  fold?: number | 'menu'
}

const ITEM = 'flex h-8 cursor-default select-none items-center gap-2 rounded-sm px-2 text-base outline-none data-[highlighted]:bg-accent-soft data-[disabled]:opacity-45'

/**
 * The pull request's actions on one row that never wraps: when it does not fit, the actions fold
 * into "More" one at a time, in their `fold` order (measured before paint, so nothing overlaps).
 */
export function PrActionsToolbar({ actions, label }: { actions: PrToolbarAction[]; label: string }) {
  const { t } = useI18n()
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  // How many foldable actions went into "More" at this width; a new width starts over.
  const [fold, setFold] = useState({ width: 0, steps: 0 })
  const steps = fold.width === width ? fold.steps : 0

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => e && e.contentRect.width > 0 && setWidth(Math.round(e.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const order = [...new Set(actions.map((a) => a.fold).filter((f): f is number => typeof f === 'number'))].sort((a, b) => a - b)
  const folded = new Set(order.slice(0, steps))
  const inMenu = (a: PrToolbarAction) => a.fold === 'menu' || (typeof a.fold === 'number' && folded.has(a.fold))
  const inline = actions.filter((a) => !inMenu(a))
  const menu = actions.filter(inMenu)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el || steps >= order.length) return
    if (el.scrollWidth > el.clientWidth + 1) setFold({ width, steps: steps + 1 })
  })

  const button = (a: PrToolbarAction) => (
    <Button key={a.key} size="sm" variant={a.variant} icon={a.icon} title={a.title} disabled={a.disabled} onClick={a.onSelect}>
      {a.label}
    </Button>
  )
  return (
    <div ref={ref} role="toolbar" aria-label={label} className="flex items-center gap-1.5 overflow-hidden border-t border-border bg-surface/50 px-5 py-2">
      {inline.filter((a) => a.side === 'start').map(button)}
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {inline.filter((a) => a.side === 'end').map(button)}
        {menu.length > 0 && (
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <IconButton size="sm" label={t('pr.detail.moreActions')} data-testid="pr-more-actions" icon={<MoreHorizontal className="size-4" aria-hidden />} />
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content align="end" sideOffset={6} className="z-50 min-w-56 animate-fade-in rounded-md border border-border bg-surface-raised p-1 shadow-lg">
                {menu.map((a, i) => (
                  <div key={a.key}>
                    {/* Destructive actions sit apart, after the rest. */}
                    {a.variant === 'danger' && i > 0 && menu[i - 1]!.variant !== 'danger' && <DropdownMenu.Separator className="my-1 h-px bg-border" />}
                    <DropdownMenu.Item disabled={a.disabled} title={a.title} onSelect={a.onSelect} className={cn(ITEM, a.variant === 'danger' && 'text-danger')}>
                      {a.icon}
                      {a.label}
                    </DropdownMenu.Item>
                  </div>
                ))}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        )}
      </div>
    </div>
  )
}
