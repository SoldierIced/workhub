import { useState } from 'react'
import { ArrowDown, ArrowUp, GripVertical } from 'lucide-react'
import { failoverCandidates, failoverMode, FAILOVER_MODES, knownAgents, moveRow, offerRow, profileAgentRows, type FailoverMode, type ProfileAgentRow } from '@workhub/core'
import type { ConfigSnapshot } from '@shared/api'
import { Avatar, Badge, IconButton, Select, Switch } from '../../components/atoms'
import { useI18n } from '../../i18n/I18nProvider'
import { cn } from '../../lib/cn'
import { usagePercent } from '../../lib/profileAgents'
import { useAccountUsage } from '../../lib/usage'
import type { Run } from './run'
import { SettingsGroup } from './SettingsLayout'
import { saveProfilePatch } from './shared'

/**
 * Settings → Profiles → a profile → Agents: one list of every account and every agent with its own
 * sign-in, the offered ones first in the profile's order (the first is the default), then the
 * account switch of the Claude accounts in that order. Every write goes to `profileId`.
 */
export function ProfileAgentsTab({ snap, run, profileId }: { snap: ConfigSnapshot; run: Run; profileId: string }) {
  const { t } = useI18n()
  const reads = useAccountUsage()
  const [dragKey, setDragKey] = useState<string | null>(null)
  const [overKey, setOverKey] = useState<string | null>(null)
  const profile = snap.config.profiles.find((p) => p.id === profileId)
  if (!profile) return <p className="px-1 text-sm text-subtle">{t('profileAgents.noProfile')}</p>

  const editable = !snap.loadError
  const rows = profileAgentRows(snap.config, profileId)
  const offered = rows.filter((r) => r.offered)
  const allAgentIds = knownAgents(snap.config).map((a) => a.id)
  const offer = (row: ProfileAgentRow, on: boolean) => void saveProfilePatch(run, profileId, (p) => offerRow(p, row, on, allAgentIds))
  const move = (key: string, delta: number) => void saveProfilePatch(run, profileId, (p) => moveRow(p, rows, key, delta))
  const drop = (target: string) => {
    const from = offered.findIndex((r) => r.key === dragKey)
    const to = offered.findIndex((r) => r.key === target)
    setDragKey(null)
    setOverKey(null)
    if (from >= 0 && to >= 0 && from !== to && dragKey) move(dragKey, to - from)
  }
  const subLine = (row: ProfileAgentRow): string => {
    if (!row.offered) return t('profileAgents.notOffered')
    if (!row.account) return t('profileAgents.ownSignIn')
    const percent = usagePercent(reads, row.agent, row.account.id)
    return [row.agent.name, row.account.configDir, percent === undefined ? undefined : t('profileAgents.usage', { percent })].filter(Boolean).join(' · ')
  }

  const claude = failoverCandidates(rows)
  const switchHint =
    claude.length > 1
      ? t('profileAgents.switch.hint', { order: claude.map((r) => r.account?.name ?? r.label).join(' → ') })
      : claude.length === 1
        ? t('profileAgents.switch.only', { name: claude[0]!.account?.name ?? claude[0]!.label })
        : t('profileAgents.switch.none')

  return (
    <div className="flex flex-col gap-6" data-testid="profile-agents">
      <SettingsGroup title={t('profileAgents.title')} footnote={t('profileAgents.footnote')} anchor="profile-agents">
        <p className="py-2 text-xs text-subtle">{t('profileAgents.hint')}</p>
        <ol className="flex flex-col py-1">
          {rows.map((row) => {
            const index = offered.indexOf(row)
            return (
              <li
                key={row.key}
                data-testid="profile-agent-row"
                data-key={row.key}
                data-offered={row.offered}
                draggable={row.offered && editable}
                onDragStart={(e) => {
                  e.dataTransfer.setData('text/plain', row.key)
                  e.dataTransfer.effectAllowed = 'move'
                  setDragKey(row.key)
                }}
                onDragEnd={() => {
                  setDragKey(null)
                  setOverKey(null)
                }}
                onDragOver={(e) => {
                  if (!dragKey || !row.offered) return
                  e.preventDefault()
                  setOverKey(row.key)
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  drop(row.key)
                }}
                className={cn('flex items-center gap-3 rounded-md px-1 py-2', !row.offered && 'opacity-60', overKey === row.key && dragKey !== row.key && 'ring-2 ring-accent/60')}
              >
                <span aria-hidden className={cn('text-subtle', row.offered && editable ? 'cursor-grab' : 'invisible')} title={t('profileAgents.drag', { name: row.label })}>
                  <GripVertical className="size-4" />
                </span>
                <Avatar name={row.account?.name ?? row.agent.name} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-base" title={row.label}>
                      {row.label}
                    </span>
                    {row.isDefault && (
                      <Badge tone="accent" data-testid="profile-agent-default">
                        {t('profileAgents.default')}
                      </Badge>
                    )}
                  </span>
                  <span className="block truncate text-xs text-subtle">{subLine(row)}</span>
                </span>
                <IconButton size="sm" label={t('profileAgents.up', { name: row.label })} icon={<ArrowUp className="size-3.5" aria-hidden />} disabled={!editable || !row.offered || index <= 0} onClick={() => move(row.key, -1)} />
                <IconButton
                  size="sm"
                  label={t('profileAgents.down', { name: row.label })}
                  icon={<ArrowDown className="size-3.5" aria-hidden />}
                  disabled={!editable || !row.offered || index < 0 || index >= offered.length - 1}
                  onClick={() => move(row.key, 1)}
                />
                <Switch aria-label={t('profileAgents.offer', { name: row.label })} checked={row.offered} disabled={!editable} onChange={(on) => offer(row, on)} />
              </li>
            )
          })}
        </ol>
      </SettingsGroup>
      <SettingsGroup title={t('profileAgents.switch.title')} anchor="profile-account-switch">
        <div className="flex items-center justify-between gap-6 py-3">
          <div className="min-w-0">
            <span className="text-base">{t('profileAgents.switch.label')}</span>
            <p className="text-xs text-subtle" data-testid="profile-agents-switch-hint">
              {switchHint}
            </p>
          </div>
          <div className="w-56 shrink-0">
            <Select
              aria-label={t('profileAgents.switch.label')}
              value={failoverMode(profile)}
              disabled={!editable || claude.length < 2}
              onChange={(v) => void saveProfilePatch(run, profileId, (p) => ({ ...p, accountFailover: v as FailoverMode }))}
              options={FAILOVER_MODES.map((m) => ({ value: m, label: t(`profileAgents.switch.${m}`) }))}
            />
          </div>
        </div>
      </SettingsGroup>
    </div>
  )
}
