import type { FolderSpendResult } from '@shared/api'
import { Spinner } from '../atoms'
import { HomeCard, HomeNote } from '../molecules/HomeCard'
import { useI18n } from '../../i18n/I18nProvider'
import type { MessageKey } from '../../i18n/translate'
import { formatTokens } from '../../lib/home'

const AGENT_NAME: Record<string, MessageKey> = { claude: 'agentUsage.agent.claude', codex: 'agentUsage.agent.codex', kiro: 'agentUsage.agent.kiro' }
const ROWS = 7

/**
 * Home's "Token spend by folder" (Workhub 1's "Claude by folder"): the active profile's folders
 * over the last days, from the transcripts the main process scans in the background.
 */
export function TokenSpendCard({ spend, onOpenSettings }: { spend: FolderSpendResult | null; onOpenSettings: () => void }) {
  const { t } = useI18n()
  const days = spend?.days ?? 7
  const entries = spend?.entries.slice(0, ROWS) ?? []
  const top = entries[0]?.tokens ?? 1
  // Before the first scan of this run, an empty cache means nothing was read yet.
  const reading = !spend || (spend.scannedAt === null && spend.entries.length === 0 && spend.hasFolders)
  return (
    <HomeCard
      title={t('home.tokensByFolder')}
      detail={t('home.tokensByFolderMeta', { days })}
      help={t('home.tokensByFolderHelp')}
      trailing={spend?.scanning && !reading ? <Spinner className="size-3" /> : undefined}
      data-testid="token-spend-card"
    >
      {spend && !spend.hasFolders ? (
        <HomeNote text={t('home.tokensByFolderNoFolders')} actionLabel={t('home.openSettings')} onAction={onOpenSettings} />
      ) : reading ? (
        <p className="flex items-center gap-2 text-sm text-muted">
          <Spinner className="size-3.5" /> {t('home.tokensByFolderLoading')}
        </p>
      ) : entries.length === 0 ? (
        <p className="text-sm text-muted">{t('home.tokensByFolderEmpty', { days })}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {entries.map((f) => {
            const name = f.root ? t('home.tokensByFolderRoot', { name: f.name }) : f.name
            const split = Object.entries(f.byAgent)
              .filter(([, n]) => (n ?? 0) > 0)
              .map(([agent, n]) => `${AGENT_NAME[agent] ? t(AGENT_NAME[agent]!) : agent} ${formatTokens(n ?? 0)}`)
              .join(' · ')
            return (
              <li key={`${f.root ? 'root' : 'dir'}:${f.path}`} className="grid grid-cols-[9.5rem_1fr_3.25rem] items-center gap-2.5 text-sm" title={`${f.path}\n${split}`}>
                <span className="truncate">{name}</span>
                <span className="h-2.5 overflow-hidden rounded-full bg-surface-hover" aria-hidden>
                  <span className="brand-gradient block h-full rounded-full" style={{ width: `${Math.max(2, (f.tokens / top) * 100)}%` }} />
                </span>
                <span className="text-right text-xs tabular-nums text-muted">{formatTokens(f.tokens)}</span>
              </li>
            )
          })}
        </ul>
      )}
    </HomeCard>
  )
}
