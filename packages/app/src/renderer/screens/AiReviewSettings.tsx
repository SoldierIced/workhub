import { useEffect, useState } from 'react'
import { aiReviewSettings, orderAgents, resolveEffectiveAgents, briefPromptOf, DEFAULT_REVIEW_BRIEF_PROMPT, MAX_REVIEW_IDLE_SECONDS, MAX_REVIEW_ROUNDS, MIN_REVIEW_IDLE_SECONDS, MIN_REVIEW_ROUNDS, pickReviewer, readOnlyGuard, type AiReviewSettings, type EffectiveAgent, type Profile, type ReviewerSessionMode, type ReviewLanguage } from '@workhub/core'
import { Button, Input, Select, Switch, Textarea } from '../components/atoms'
import { Card, EmptyState, Field, SwitchRow } from '../components/molecules'
import { useI18n } from '../i18n/I18nProvider'
import { useAgentOptions, withCurrent } from '../lib/agentOptions'
import type { ConfigSnapshot } from '@shared/api'
import { useUnsavedForm } from '../components/organisms/UnsavedChanges'
import { isDirty, type SaveOutcome } from '../lib/unsavedChanges'
import type { Run } from './settings/run'
import { saveProfilePatch } from './settings/shared'

const clamp = (n: number, min: number, max: number, fallback: number) => (Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback)

/** The profile's "AI review" fields (Settings → AI review); edits a draft, saved by `AiReviewSection`. */
export function AiReviewProfileFields({ form, agents, onChange }: { form: Profile; agents: readonly EffectiveAgent[]; onChange: (aiReview: AiReviewSettings) => void }) {
  const { t } = useI18n()
  const s = aiReviewSettings(form)
  const set = (patch: Partial<AiReviewSettings>) => onChange({ ...s, ...patch })
  const reviewers = agents.filter((a) => a.agent.capabilities.appMode)
  const fallback = pickReviewer({ ...form, aiReview: { ...s, reviewerAgent: null } }, agents)
  const reviewer = pickReviewer(form, agents)
  const { options } = useAgentOptions(reviewer?.key)
  const models = options?.models ?? []
  return (
    <div className="flex flex-col gap-3 py-2" data-testid="ai-review-settings">
      <p className="text-sm text-subtle">{t('aiReview.settings.hint')}</p>
      <SwitchRow label={t('aiReview.settings.enabled')}>
        <Switch checked={s.enabled} onChange={(on) => set({ enabled: on })} />
      </SwitchRow>
      <SwitchRow label={t('aiReview.settings.auto')}>
        <Switch checked={s.auto} disabled={!s.enabled} onChange={(on) => set({ auto: on })} />
      </SwitchRow>
      <SwitchRow label={t('agentReview.approve')} hint={t('agentReview.approveHint')}>
        <Switch checked={s.approveFindings} disabled={!s.enabled} onChange={(on) => set({ approveFindings: on })} />
      </SwitchRow>
      {reviewer && readOnlyGuard(reviewer.agent) === 'refusals' && (
        <p role="alert" className="rounded-md bg-warning-soft px-3 py-2 text-sm text-warning" data-testid="ai-review-no-readonly">
          {t('aiReview.settings.noReadOnly', { name: reviewer.label })}
        </p>
      )}
      <div className="grid grid-cols-2 gap-4">
        <Field label={t('aiReview.settings.reviewer')} help={t('help.aiReview.reviewer')}>
          <Select
            value={s.reviewerAgent ?? ''}
            onChange={(v) => set({ reviewerAgent: v || null, ...(v !== (s.reviewerAgent ?? '') ? { reviewerModel: '' } : {}) })}
            options={[
              { value: '', label: fallback ? t('aiReview.settings.reviewerDefault', { name: fallback.label }) : t('aiReview.settings.reviewerNone') },
              ...reviewers.map((a) => ({ value: a.key, label: a.label })),
              ...(s.reviewerAgent && !reviewers.some((a) => a.key === s.reviewerAgent) ? [{ value: s.reviewerAgent, label: s.reviewerAgent }] : [])
            ]}
          />
        </Field>
        <Field label={t('aiReview.settings.reviewerModel')} hint={t('aiReview.settings.reviewerModelHint')}>
          {models.length ? (
            <Select
              value={s.reviewerModel}
              onChange={(v) => set({ reviewerModel: v })}
              data-testid="ai-review-reviewer-model"
              options={[{ value: '', label: t('aiReview.settings.reviewerModelPlaceholder') }, ...withCurrent(models.map((m) => ({ value: m.id, label: m.name })), s.reviewerModel || undefined)]}
            />
          ) : (
            <Input value={s.reviewerModel} spellCheck={false} placeholder={t('aiReview.settings.reviewerModelPlaceholder')} onChange={(e) => set({ reviewerModel: e.target.value })} onBlur={() => set({ reviewerModel: s.reviewerModel.trim() })} />
          )}
        </Field>
        <Field label={t('aiReview.settings.reviewerEffort')} hint={t('aiReview.settings.reviewerEffortHint')}>
          <Input value={s.reviewerEffort} spellCheck={false} placeholder={t('aiReview.settings.reviewerModelPlaceholder')} onChange={(e) => set({ reviewerEffort: e.target.value })} onBlur={() => set({ reviewerEffort: s.reviewerEffort.trim() })} />
        </Field>
        <Field label={t('aiReview.settings.reviewerSession')} hint={t('aiReview.settings.reviewerSessionHint')}>
          <Select
            value={s.reviewerSession}
            onChange={(v) => set({ reviewerSession: v as ReviewerSessionMode })}
            options={[
              { value: 'same', label: t('aiReview.settings.reviewerSession.same') },
              { value: 'new', label: t('aiReview.settings.reviewerSession.new') }
            ]}
          />
        </Field>
        <Field label={t('aiReview.settings.baseBranch')} hint={t('aiReview.settings.baseBranchHint')}>
          <Input value={s.baseBranch} spellCheck={false} placeholder="develop" onChange={(e) => set({ baseBranch: e.target.value })} onBlur={() => set({ baseBranch: s.baseBranch.trim() || 'develop' })} />
        </Field>
        <Field label={t('aiReview.settings.maxRounds')} help={t('help.aiReview.maxRounds')}>
          <Input type="number" min={MIN_REVIEW_ROUNDS} max={MAX_REVIEW_ROUNDS} value={s.maxRounds} onChange={(e) => set({ maxRounds: clamp(e.target.valueAsNumber, MIN_REVIEW_ROUNDS, MAX_REVIEW_ROUNDS, s.maxRounds) })} />
        </Field>
        <Field label={t('aiReview.settings.idleSeconds')} help={t('help.aiReview.idleSeconds')}>
          <Input type="number" min={MIN_REVIEW_IDLE_SECONDS} max={MAX_REVIEW_IDLE_SECONDS} value={s.idleSeconds} onChange={(e) => set({ idleSeconds: clamp(e.target.valueAsNumber, MIN_REVIEW_IDLE_SECONDS, MAX_REVIEW_IDLE_SECONDS, s.idleSeconds) })} />
        </Field>
        <Field label={t('aiReview.settings.language')}>
          <Select value={s.language} onChange={(v) => set({ language: v as ReviewLanguage })} options={[{ value: 'en', label: 'English' }, { value: 'es', label: 'Español' }]} />
        </Field>
      </div>
      <Field label={t('aiReview.settings.checklist')} hint={t('aiReview.settings.checklistHint')}>
        <Textarea rows={4} value={s.checklist} spellCheck={false} onChange={(e) => set({ checklist: e.target.value })} />
      </Field>
      <Field
        label={t('aiReview.settings.briefPrompt')}
        hint={
          <span className="flex items-center gap-2">
            <span className="flex-1">{t('aiReview.settings.briefPromptHint')}</span>
            {s.briefPrompt && (
              <Button size="sm" variant="ghost" onClick={() => set({ briefPrompt: '' })}>
                {t('aiReview.settings.briefPromptReset')}
              </Button>
            )}
          </span>
        }
      >
        {/* Stored empty while it is the default, so a later default reaches every profile that never changed it. */}
        <Textarea rows={8} value={briefPromptOf(s)} spellCheck={false} data-testid="ai-review-brief-prompt" onChange={(e) => set({ briefPrompt: e.target.value === DEFAULT_REVIEW_BRIEF_PROMPT ? '' : e.target.value })} />
      </Field>
    </div>
  )
}

/**
 * Settings → AI review: the fields above for one profile (the active one unless given), with their
 * own save bar entry. Saving re-reads the profile, so other sections saved by the same bar stay.
 */
export function AiReviewSection({ snap, run, profileId }: { snap: ConfigSnapshot; run: Run; profileId?: string | null }) {
  const { t } = useI18n()
  const profile = snap.config.profiles.find((p) => p.id === (profileId ?? snap.config.activeProfileId))
  const saved = profile ? aiReviewSettings(profile) : null
  const [draft, setDraft] = useState<AiReviewSettings | null>(saved)
  const [baseline, setBaseline] = useState<AiReviewSettings | null>(saved)
  useEffect(() => {
    const next = profile ? aiReviewSettings(profile) : null
    setDraft(next)
    setBaseline(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.id])
  const save = async (): Promise<SaveOutcome> => {
    if (!profile || !draft) return { ok: true }
    if (!(await saveProfilePatch(run, profile.id, (p) => ({ ...p, aiReview: draft })))) return { ok: false }
    setBaseline(draft)
    return { ok: true }
  }
  useUnsavedForm({ dirty: draft !== null && isDirty(baseline, draft), draft, save, discard: () => setDraft(baseline) })
  if (!profile || !draft) return <EmptyState compact title={t('settings.profileFirst')} />
  const agents = orderAgents(profile.preferredAgents, resolveEffectiveAgents(snap.config, profile.id))
  return (
    <Card className="px-4">
      <AiReviewProfileFields form={{ ...profile, aiReview: draft }} agents={agents} onChange={setDraft} />
    </Card>
  )
}
