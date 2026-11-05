import { useEffect, useState } from 'react'
import type { AgentOptionsView } from '@shared/api'

/** The models and modes the chosen agent offers (its CLI's listing, or what its last session reported). */
export function useAgentOptions(agentKey: string | undefined): { options: AgentOptionsView | null } {
  const [options, setOptions] = useState<AgentOptionsView | null>(null)
  useEffect(() => {
    let live = true
    setOptions(null)
    if (!agentKey) return
    void window.hub.agents.options(agentKey).then(
      (o) => live && setOptions(o),
      () => undefined
    )
    return () => {
      live = false
    }
  }, [agentKey])
  return { options }
}

/** Keeps a stored pick visible when the agent's list no longer (or not yet) offers it. */
export function withCurrent(list: { value: string; label: string }[], current: string | undefined) {
  return current && !list.some((o) => o.value === current) ? [...list, { value: current, label: current }] : list
}
