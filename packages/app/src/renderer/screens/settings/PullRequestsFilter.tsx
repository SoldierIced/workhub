import { useState } from 'react'
import { isPullRequestOwner, isRepoPattern, type PullRequestFilterSettings } from '@workhub/core'
import { Textarea } from '../../components/atoms'
import { Field } from '../../components/molecules'
import { useI18n } from '../../i18n/I18nProvider'

/** One entry per line (commas and spaces also separate), blanks dropped. */
export function linesOf(text: string): string[] {
  return text
    .split(/[\n,\s]+/)
    .map((l) => l.trim())
    .filter(Boolean)
}

/** The filter as the profile stores it; undefined when it sets nothing. */
export function filterFromLists(owners: string[], excludeRepos: string[]): PullRequestFilterSettings | undefined {
  if (owners.length === 0 && excludeRepos.length === 0) return undefined
  return { ...(owners.length ? { owners } : {}), ...(excludeRepos.length ? { excludeRepos } : {}) }
}

/**
 * Settings → Profiles › a profile › Screens › Pull requests: the owners whose pull requests this
 * profile shows and the repositories it hides. Part of the screens form (one save bar).
 */
export function PullRequestsFilterFields({ value, editable, onChange }: { value: PullRequestFilterSettings | undefined; editable: boolean; onChange: (next: PullRequestFilterSettings | undefined) => void }) {
  const { t } = useI18n()
  const [owners, setOwners] = useState(() => (value?.owners ?? []).join('\n'))
  const [excluded, setExcluded] = useState(() => (value?.excludeRepos ?? []).join('\n'))
  const badOwners = linesOf(owners).filter((o) => !isPullRequestOwner(o.replace(/^@/, '')))
  const badRepos = linesOf(excluded).filter((r) => !isRepoPattern(r))
  const update = (nextOwners: string, nextExcluded: string) => onChange(filterFromLists(linesOf(nextOwners), linesOf(nextExcluded)))
  return (
    <div className="flex flex-col gap-4" data-testid="pull-requests-filter">
      <p className="text-sm text-muted">{t('prFilter.intro')}</p>
      <Field label={t('prFilter.owners')} hint={t('prFilter.ownersHint')} error={badOwners.length ? t('prFilter.invalid', { list: badOwners.join(', ') }) : undefined}>
        <Textarea
          rows={3}
          spellCheck={false}
          placeholder={'acme\nana'}
          disabled={!editable}
          value={owners}
          onChange={(e) => {
            setOwners(e.target.value)
            update(e.target.value, excluded)
          }}
        />
      </Field>
      <Field label={t('prFilter.exclude')} hint={t('prFilter.excludeHint')} error={badRepos.length ? t('prFilter.invalid', { list: badRepos.join(', ') }) : undefined}>
        <Textarea
          rows={3}
          spellCheck={false}
          placeholder={'acme/legacy-api\nacme/sandbox-*'}
          disabled={!editable}
          value={excluded}
          onChange={(e) => {
            setExcluded(e.target.value)
            update(owners, e.target.value)
          }}
        />
      </Field>
    </div>
  )
}
