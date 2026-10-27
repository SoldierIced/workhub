import { aiReviewSettings, MAX_REVIEW_IDLE_SECONDS, MAX_REVIEW_ROUNDS, MIN_REVIEW_IDLE_SECONDS, MIN_REVIEW_ROUNDS, pickReviewer, readOnlyGuard, type AiReviewSettings, type EffectiveAgent, type Profile, type ReviewLanguage } from '@workhub/core'
import { Input, Select, Switch, Textarea } from '../components/atoms'
import { Field, SwitchRow } from '../components/molecules'
import { useI18n } from '../i18n/I18nProvider'

const clamp = (n: number, min: number, max: number, fallback: number) => (Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback)

/** The profile's "AI review" fields (Settings → Profiles); edits the profile form, saved with it. */
export function AiReviewProfileFields({ form, agents, onChange }: { form: Profile; agents: readonly EffectiveAgent[]; onChange: (aiReview: AiReviewSettings) => void }) {
  const { t } = useI18n()
  const s = aiReviewSettings(form)
  const set = (patch: Partial<AiReviewSettings>) => onChange({ ...s, ...patch })
  const reviewers = agents.filter((a) => a.agent.capabilities.appMode)
  const fallback = pickReviewer({ ...form, aiReview: { ...s, reviewerAgent: null } }, agents)
  const reviewer = pickReviewer(form, agents)
  return (
    <div className="flex flex-col gap-3 py-2" data-testid="ai-review-settings">
      <p className="text-sm text-subtle">{t('aiReview.settings.hint')}</p>
      <SwitchRow label={t('aiReview.settings.enabled')}>
        <Switch checked={s.enabled} onChange={(on) => set({ enabled: on })} />
      </SwitchRow>
      <SwitchRow label={t('aiReview.settings.auto')}>
        <Switch checked={s.auto} disabled={!s.enabled} onChange={(on) => set({ auto: on })} />
      </SwitchRow>
      {reviewer && readOnlyGuard(reviewer.agent) === 'refusals' && (
        <p role="alert" className="rounded-md bg-warning-soft px-3 py-2 text-sm text-warning" data-testid="ai-review-no-readonly">
          {t('aiReview.settings.noReadOnly', { name: reviewer.label })}
        </p>
      )}
      <div className="grid grid-cols-2 gap-4">
        <Field label={t('aiReview.settings.reviewer')}>
          <Select
            value={s.reviewerAgent ?? ''}
            onChange={(v) => set({ reviewerAgent: v || null })}
            options={[
              { value: '', label: fallback ? t('aiReview.settings.reviewerDefault', { name: fallback.label }) : t('aiReview.settings.reviewerNone') },
              ...reviewers.map((a) => ({ value: a.key, label: a.label })),
              ...(s.reviewerAgent && !reviewers.some((a) => a.key === s.reviewerAgent) ? [{ value: s.reviewerAgent, label: s.reviewerAgent }] : [])
            ]}
          />
        </Field>
        <Field label={t('aiReview.settings.reviewerModel')} hint={t('aiReview.settings.reviewerModelHint')}>
          <Input value={s.reviewerModel} spellCheck={false} placeholder={t('aiReview.settings.reviewerModelPlaceholder')} onChange={(e) => set({ reviewerModel: e.target.value })} onBlur={() => set({ reviewerModel: s.reviewerModel.trim() })} />
        </Field>
        <Field label={t('aiReview.settings.baseBranch')} hint={t('aiReview.settings.baseBranchHint')}>
          <Input value={s.baseBranch} spellCheck={false} placeholder="develop" onChange={(e) => set({ baseBranch: e.target.value })} onBlur={() => set({ baseBranch: s.baseBranch.trim() || 'develop' })} />
        </Field>
        <Field label={t('aiReview.settings.maxRounds')}>
          <Input type="number" min={MIN_REVIEW_ROUNDS} max={MAX_REVIEW_ROUNDS} value={s.maxRounds} onChange={(e) => set({ maxRounds: clamp(e.target.valueAsNumber, MIN_REVIEW_ROUNDS, MAX_REVIEW_ROUNDS, s.maxRounds) })} />
        </Field>
        <Field label={t('aiReview.settings.idleSeconds')}>
          <Input type="number" min={MIN_REVIEW_IDLE_SECONDS} max={MAX_REVIEW_IDLE_SECONDS} value={s.idleSeconds} onChange={(e) => set({ idleSeconds: clamp(e.target.valueAsNumber, MIN_REVIEW_IDLE_SECONDS, MAX_REVIEW_IDLE_SECONDS, s.idleSeconds) })} />
        </Field>
        <Field label={t('aiReview.settings.language')}>
          <Select value={s.language} onChange={(v) => set({ language: v as ReviewLanguage })} options={[{ value: 'en', label: 'English' }, { value: 'es', label: 'Español' }]} />
        </Field>
      </div>
      <Field label={t('aiReview.settings.checklist')} hint={t('aiReview.settings.checklistHint')}>
        <Textarea rows={4} value={s.checklist} spellCheck={false} onChange={(e) => set({ checklist: e.target.value })} />
      </Field>
    </div>
  )
}
