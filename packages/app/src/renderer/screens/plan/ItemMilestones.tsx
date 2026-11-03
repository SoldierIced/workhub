import { Check, Flag } from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import { useState } from 'react'
import { assignProblem, milestoneHasItem, withItem, withoutItem, type InboxItem } from '@workhub/core'
import type { MilestoneView } from '@shared/planner-api'
import { Spinner } from '../../components/atoms'
import { useToast } from '../../components/molecules'
import { useI18n } from '../../i18n/I18nProvider'
import { cn } from '../../lib/cn'
import { errorText } from '../../lib/errorText'

/**
 * The milestones an inbox item belongs to, as chips that open them, and a menu to add it to a
 * milestone or take it out. Only milestones made of pieces take items; the others are listed
 * disabled, with the reason. `hide` leaves out the chip of the milestone the item is shown under.
 */
export function ItemMilestones({ item, milestones, profileId, hide, onOpen }: { item: Pick<InboxItem, 'id' | 'ticket' | 'title'>; milestones: readonly MilestoneView[]; profileId: string; hide?: string; onOpen: (id: string) => void }) {
  const { t } = useI18n()
  const toast = useToast()
  const [saving, setSaving] = useState<string | null>(null)
  const member = milestones.filter((m) => milestoneHasItem(m.milestone, item))
  // Done milestones are offered only to take the item out.
  const offered = milestones.filter((m) => m.status !== 'done' || milestoneHasItem(m.milestone, item))

  const toggle = async (row: MilestoneView) => {
    const on = milestoneHasItem(row.milestone, item)
    const next = on ? withoutItem(row.milestone, item) : withItem(row.milestone, item)
    if (next === row.milestone) return
    setSaving(row.milestone.id)
    try {
      const r = await window.hub.planner.saveMilestone(profileId, next)
      if (!r.ok) toast(r.error, 'danger')
    } catch (e) {
      toast(errorText(e), 'danger')
    } finally {
      setSaving(null)
    }
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-1" data-testid="item-milestones">
      {member
        .filter((m) => m.milestone.id !== hide)
        .map((m) => (
          <button
            key={m.milestone.id}
            type="button"
            onClick={() => onOpen(m.milestone.id)}
            title={t('planner.assign.open', { name: m.milestone.name })}
            className="inline-flex max-w-64 items-center gap-1 rounded-full border border-accent/40 bg-accent-soft px-2 py-px text-xs text-accent hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <Flag className="size-3 shrink-0" aria-hidden />
            <span className="truncate">{m.milestone.name}</span>
          </button>
        ))}
      <DropdownMenu.Root>
        <DropdownMenu.Trigger
          aria-label={t('planner.assign.menu', { title: item.title })}
          className={cn(
            'inline-flex items-center gap-1 rounded-full border border-dashed px-2 py-px text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
            member.length === 0 ? 'border-warning/50 text-warning hover:bg-warning-soft' : 'border-border text-subtle hover:bg-surface-hover'
          )}
        >
          {saving ? <Spinner /> : <Flag className="size-3" aria-hidden />}
          {member.length === 0 ? t('planner.assign.none') : t('planner.assign.change')}
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="start" sideOffset={6} className="z-50 max-w-96 min-w-64 animate-fade-in rounded-md border border-border bg-surface-raised p-1 shadow-lg">
            <DropdownMenu.Label className="px-2 py-1 text-xs font-medium text-subtle">{t('planner.assign.title')}</DropdownMenu.Label>
            {offered.length === 0 && <div className="px-2 py-1.5 text-sm text-muted">{t('planner.assign.noMilestones')}</div>}
            {offered.map((m) => {
              const on = milestoneHasItem(m.milestone, item)
              const problem = on ? null : assignProblem(m.milestone)
              return (
                <DropdownMenu.CheckboxItem
                  key={m.milestone.id}
                  checked={on}
                  disabled={problem !== null || saving !== null}
                  onSelect={(e) => {
                    e.preventDefault()
                    void toggle(m)
                  }}
                  className="flex cursor-default select-none items-start gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent-soft"
                >
                  <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">{on && <Check className="size-3.5 text-accent" aria-hidden />}</span>
                  <span className="min-w-0">
                    <span className="block break-words">{m.milestone.name}</span>
                    {problem && <span className="block text-xs text-subtle">{t(problem === 'full' ? 'planner.assign.full' : 'planner.assign.notPieces')}</span>}
                  </span>
                </DropdownMenu.CheckboxItem>
              )
            })}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </span>
  )
}
