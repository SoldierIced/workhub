import { useEffect, useState } from 'react'
import type { OfferedModule } from '@workhub/core'
import type { AgentToolsStatus, SkillState } from '@shared/agent-tools-api'
import { Badge, Button } from '../../components/atoms'
import { Dialog, useToast } from '../../components/molecules'
import { useI18n } from '../../i18n/I18nProvider'
import { SKILL_TONE } from './AgentToolsGroup'

/** The skill that teaches agents a screen's endpoints, for the screens that have one. */
export const MODULE_SKILL: Partial<Record<OfferedModule, string>> = {
  boards: 'workhub-board',
  automations: 'workhub-automations',
  flowMaps: 'workhub-flow-map',
  planner: 'workhub-plan'
}

export interface SkillTarget {
  /** A Claude account id, or `agent:<id>`. */
  id: string
  /** The agent and, for a Claude account of its own, the account. */
  label: string
  dir: string
  state: SkillState
}

/** Where one skill can go: every Claude folder and every other agent installed here, with the skill's state there. */
export function skillTargets(status: AgentToolsStatus, skill: string, claude: (accountName: string) => string): SkillTarget[] {
  return [
    ...status.accounts.map((a) => ({ id: a.id, label: claude(a.name), dir: `${a.dir}/skills`, state: a.skills[skill] ?? 'missing' })),
    ...status.agents.map((a) => ({ id: a.id, label: a.name, dir: a.dir, state: a.skills[skill] ?? 'missing' }))
  ]
}

/** A target the skill still has to reach: missing, or Workhub's older copy. */
export const needsSkill = (state: SkillState) => state === 'missing' || state === 'outdated'

/**
 * Asked when a screen with a skill is turned on (Settings → Profiles › Screens): which agents get
 * the skill. Every agent that lacks it starts checked; installing happens right away, apart from
 * the profile's save.
 */
export function InstallSkillDialog({ skill, screen, onClose }: { skill: string | null; screen: string; onClose: () => void }) {
  const { t } = useI18n()
  const toast = useToast()
  const [targets, setTargets] = useState<SkillTarget[] | null>(null)
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!skill) return
    setTargets(null)
    window.hub.agentTools.status().then(
      (status) => {
        const list = skillTargets(status, skill, (name) => (name ? `Claude Code · ${name}` : 'Claude Code'))
        setTargets(list)
        setPicked(new Set(list.filter((x) => needsSkill(x.state)).map((x) => x.id)))
      },
      () => setTargets([])
    )
  }, [skill])
  const install = async () => {
    if (!skill) return
    setBusy(true)
    const failed: string[] = []
    for (const id of picked) {
      try {
        await window.hub.agentTools.installSkills(id, [skill])
      } catch (e) {
        failed.push(`${targets?.find((x) => x.id === id)?.label ?? id}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    setBusy(false)
    if (failed.length) toast(t('agentTools.failed', { error: failed.join('; ') }), 'danger')
    else toast(t('agentTools.done'))
    onClose()
  }
  const pending = targets?.filter((x) => needsSkill(x.state)) ?? []
  return (
    <Dialog
      open={skill !== null}
      onOpenChange={(open) => !open && !busy && onClose()}
      title={t('agentTools.ask.title', { screen })}
      description={t('agentTools.ask.description', { skill: skill ?? '' })}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {t('agentTools.ask.skip')}
          </Button>
          {pending.length > 0 && (
            <Button disabled={busy || picked.size === 0} onClick={() => void install()} data-testid="install-skill-confirm">
              {t('agentTools.install')}
            </Button>
          )}
        </>
      }
    >
      {targets === null ? (
        <p className="text-sm text-muted">{t('agentTools.ask.loading')}</p>
      ) : targets.length === 0 ? (
        <p className="text-sm text-muted">{t('agentTools.ask.none')}</p>
      ) : (
        <div className="flex flex-col gap-2" data-testid="install-skill-targets">
          {targets.map((x) => (
            <label key={x.id} className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={needsSkill(x.state) ? picked.has(x.id) : true}
                disabled={!needsSkill(x.state) || busy}
                onChange={(e) => setPicked((s) => (e.target.checked ? new Set([...s, x.id]) : new Set([...s].filter((id) => id !== x.id))))}
              />
              <span className="min-w-0 flex-1">
                {x.label} <Badge tone={SKILL_TONE[x.state]}>{t(`agentTools.skills.${x.state}`)}</Badge>
                <code className="block truncate text-xs text-subtle">{x.dir}</code>
                {x.id === 'agent:kiro' && <span className="block text-xs text-subtle">{t('agentTools.kiroHint', { dir: x.dir })}</span>}
              </span>
            </label>
          ))}
        </div>
      )}
    </Dialog>
  )
}
