import { useCallback, useEffect, useState } from 'react'
import type { ConfigSnapshot } from '@shared/api'
import type { AgentToolsAccount, AgentToolsStatus, SkillState } from '@shared/agent-tools-api'
import { Badge, Button, Switch } from '../../components/atoms'
import { useToast } from '../../components/molecules'
import { useI18n } from '../../i18n/I18nProvider'
import { AGENTS_ROW_IDS } from './agents-index'
import { SettingsGroup } from './SettingsLayout'
import type { Run } from './run'

/** The least installed state among an account's skills: one missing or outdated skill shows for all. */
export function skillsSummary(account: Pick<AgentToolsAccount, 'skills'>): SkillState {
  const states = Object.values(account.skills)
  for (const s of ['missing', 'outdated', 'own'] as const) if (states.includes(s)) return s
  return 'current'
}

export const SKILL_TONE: Record<SkillState, 'neutral' | 'success' | 'warning'> = { missing: 'neutral', current: 'success', outdated: 'warning', own: 'neutral' }

/**
 * Settings → Agents → Workhub tools: the MCP server for sessions; per Claude folder the skills and
 * the MCP outside Workhub; and the skills of the other agents installed here (Codex, OpenCode,
 * Gemini CLI, Kiro).
 */
export function AgentToolsGroup({ snap, run }: { snap: ConfigSnapshot; run: Run }) {
  const { t } = useI18n()
  const toast = useToast()
  const [status, setStatus] = useState<AgentToolsStatus | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const refresh = useCallback(() => {
    void window.hub.agentTools.status().then(setStatus, () => setStatus(null))
  }, [])
  useEffect(refresh, [refresh, snap.config.accounts])
  const mcpOn = snap.config.options?.workhubMcp ?? true
  const act = async (key: string, op: () => Promise<{ ok: boolean; output: string } | string[]>) => {
    setBusy(key)
    try {
      const r = await op()
      if (Array.isArray(r) || r.ok) toast(t('agentTools.done'))
      else toast(t('agentTools.failed', { error: r.output.split('\n')[0] ?? '' }), 'danger')
    } catch (e) {
      toast(t('agentTools.failed', { error: e instanceof Error ? e.message : String(e) }), 'danger')
    } finally {
      setBusy(null)
      refresh()
    }
  }
  const skillsRow = (id: string, states: Record<string, SkillState>, hint: string) => {
    const skills = skillsSummary({ skills: states })
    const values = Object.values(states)
    // Some skills only (a screen's skill installed when it was turned on): say how many.
    const some = values.filter((s) => s !== 'missing').length
    return (
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <span className="text-sm">{t('agentTools.skills')}</span>{' '}
          {skills === 'missing' && some > 0 ? (
            <Badge tone="neutral">{t('agentTools.skills.some', { count: some, total: values.length })}</Badge>
          ) : (
            <Badge tone={SKILL_TONE[skills]}>{t(`agentTools.skills.${skills}`)}</Badge>
          )}
          <p className="text-xs text-subtle">{hint}</p>
        </div>
        <div className="flex shrink-0 gap-2">
          {(skills === 'missing' || skills === 'outdated') && (
            <Button size="sm" disabled={busy !== null} onClick={() => void act(`skills:${id}`, () => window.hub.agentTools.installSkills(id))}>
              {t(skills === 'outdated' ? 'agentTools.update' : 'agentTools.install')}
            </Button>
          )}
          {Object.values(states).some((s) => s === 'current' || s === 'outdated') && (
            <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void act(`skills:${id}`, () => window.hub.agentTools.removeSkills(id))}>
              {t('agentTools.remove')}
            </Button>
          )}
        </div>
      </div>
    )
  }
  return (
    <SettingsGroup title={t('agentTools.title')} help={t('agentTools.help')}>
      <div className="flex items-center justify-between gap-6 py-3" data-setting-id={AGENTS_ROW_IDS.toolsMcp} data-settings-row>
        <div className="min-w-0">
          <span className="text-base">{t('agentTools.mcp')}</span>
          <p className="text-xs text-subtle">{t('agentTools.mcpHint')}</p>
        </div>
        <Switch aria-label={t('agentTools.mcp')} checked={mcpOn} disabled={!!snap.loadError} onChange={(v) => void run(() => window.hub.config.saveOptions({ workhubMcp: v }))} />
      </div>
      <div className="flex flex-col divide-y divide-border" data-setting-id={AGENTS_ROW_IDS.tools} data-settings-row>
        {status?.accounts.map((a) => {
        return (
          <div key={a.id} className="flex flex-col gap-2 py-3" data-testid="agent-tools-account">
            <span className="text-sm text-muted">
              {t('agentTools.account')}: {a.name || t('agentTools.defaultAccount')} <code className="text-xs">{a.dir}</code>
            </span>
            {skillsRow(a.id, a.skills, t('agentTools.skillsHint', { dir: a.dir }))}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <span className="text-sm">{t('agentTools.globalMcp')}</span> <Badge tone={a.globalMcp === 'installed' ? 'success' : 'neutral'}>{t(`agentTools.globalMcp.${a.globalMcp}`)}</Badge>
                <p className="text-xs text-subtle">{t('agentTools.globalMcpHint')}</p>
              </div>
              {status.globalMcpAvailable && a.globalMcp !== 'noClaude' && (
                <Button
                  size="sm"
                  variant={a.globalMcp === 'installed' ? 'ghost' : undefined}
                  disabled={busy !== null}
                  onClick={() => void act(`mcp:${a.id}`, () => (a.globalMcp === 'installed' ? window.hub.agentTools.removeGlobalMcp(a.id) : window.hub.agentTools.installGlobalMcp(a.id)))}
                >
                  {t(a.globalMcp === 'installed' ? 'agentTools.remove' : 'agentTools.install')}
                </Button>
              )}
            </div>
          </div>
        )
        })}
        {status?.agents.map((a) => (
          <div key={a.id} className="flex flex-col gap-2 py-3" data-testid="agent-tools-agent">
            <span className="text-sm text-muted">
              {a.name} <code className="text-xs">{a.dir}</code>
            </span>
            {skillsRow(a.id, a.skills, t(a.agentId === 'kiro' ? 'agentTools.kiroHint' : 'agentTools.agentSkillsHint', { dir: a.dir }))}
          </div>
        ))}
      </div>
    </SettingsGroup>
  )
}
