import { ArrowDown, ArrowUp } from 'lucide-react'
import type { EffectiveAgent } from '@workhub/core'
import { useI18n } from '../../i18n/I18nProvider'
import { Badge } from '../atoms/Badge'
import { IconButton } from '../atoms/IconButton'

export interface AgentOrderListProps {
  /** The agents in the user's order; the first one is the default. */
  agents: readonly EffectiveAgent[]
  /** Called with the full new order, as agent keys. */
  onChange: (keys: string[]) => void
}

/** The agents of a profile in the order Workhub picks them on its own, with up and down buttons. */
export function AgentOrderList({ agents, onChange }: AgentOrderListProps) {
  const { t } = useI18n()
  const move = (index: number, by: -1 | 1) => {
    const keys = agents.map((a) => a.key)
    const target = index + by
    if (target < 0 || target >= keys.length) return
    ;[keys[index], keys[target]] = [keys[target]!, keys[index]!]
    onChange(keys)
  }
  return (
    <ol className="flex flex-col gap-1 py-2">
      {agents.map((a, i) => (
        <li key={a.key} className="flex items-center gap-2 rounded-md px-1 py-0.5 text-base">
          <span className="min-w-0 flex-1 truncate">{a.label}</span>
          {i === 0 && <Badge tone="accent">{t('settings.agentOrder.default')}</Badge>}
          <IconButton size="sm" label={t('settings.agentOrder.up', { name: a.label })} icon={<ArrowUp className="size-3.5" aria-hidden />} disabled={i === 0} onClick={() => move(i, -1)} />
          <IconButton size="sm" label={t('settings.agentOrder.down', { name: a.label })} icon={<ArrowDown className="size-3.5" aria-hidden />} disabled={i === agents.length - 1} onClick={() => move(i, 1)} />
        </li>
      ))}
    </ol>
  )
}
