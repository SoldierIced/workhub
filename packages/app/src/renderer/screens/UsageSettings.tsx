import type { ConfigSnapshot } from '@shared/api'
import type { Run } from './settings/run'

/**
 * Former Settings → Usage. The reading switches now sit under each agent's card and the ceilings
 * in each account's form (Settings → Agents, `AccountsSection`); the usage alerts are in
 * Notifications and alerts. Kept so the shell can still import it while it stops rendering it:
 * it renders nothing, so a shell that shows it under Agents shows nothing twice.
 */
export function UsageSettings(_props: { snap: ConfigSnapshot; run: Run }) {
  return null
}
