import type { AutomationRun } from '@workhub/core'

/**
 * What the run log shows for a run's spend: its cost when the agent reported one, else its token
 * count, else nothing. A zero cost with tokens falls back to the tokens (an agent that bills nothing).
 */
export function runUsageLabel(run: Pick<AutomationRun, 'cost' | 'tokens'>, format: { money: (cost: { amount: number; currency: string }) => string; tokens: (n: number) => string }): string | null {
  if (run.cost && run.cost.amount > 0) return format.money(run.cost)
  if (run.tokens && run.tokens > 0) return format.tokens(run.tokens)
  return run.cost ? format.money(run.cost) : null
}
