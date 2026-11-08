import type { ConfigSnapshot } from '../../shared/api'
import { useI18n } from '../../renderer/i18n/I18nProvider'

/** The profile a list screen shows; hidden with a single profile. */
export function ProfilePicker({ config, value, onChange }: { config: ConfigSnapshot | null; value: string | null; onChange: (id: string | null) => void }) {
  const { t } = useI18n()
  const profiles = config?.config.profiles ?? []
  if (profiles.length < 2) return null
  return (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} aria-label={t('web.new.profile')} className="h-9 max-w-36 rounded-full border border-border-strong bg-surface px-3 text-sm text-text">
      {profiles.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  )
}
