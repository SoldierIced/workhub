import { Check } from 'lucide-react'
import { PROFILE_COLORS } from '@workhub/core'
import { useI18n } from '../i18n/I18nProvider'
import { cn } from '../lib/cn'

export interface ProfileColorFieldProps {
  /** The colour the profile chose; undefined while it takes the automatic one. */
  value: string | undefined
  /** The colour the profile shows without a choice (its place in the palette). */
  automatic: string
  onChange: (color: string | undefined) => void
}

/** The profile's colour: one of the palette, or automatic (by its place in the list). */
export function ProfileColorField({ value, automatic, onChange }: ProfileColorFieldProps) {
  const { t } = useI18n()
  const swatch = (color: string | undefined, label: string) => {
    const selected = value === color
    return (
      <button
        key={color ?? 'auto'}
        type="button"
        role="radio"
        aria-checked={selected}
        aria-label={label}
        title={label}
        onClick={() => onChange(color)}
        style={{ backgroundColor: color ?? automatic }}
        className={cn(
          'relative inline-flex size-6 items-center justify-center rounded-full ring-offset-2 ring-offset-surface transition-shadow',
          selected ? 'ring-2 ring-text' : 'hover:ring-2 hover:ring-border',
          color === undefined && 'bg-clip-padding outline-1 outline-white/60 outline-dashed -outline-offset-4'
        )}
      >
        {selected && <Check className="size-3.5 text-white" aria-hidden />}
      </button>
    )
  }
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-muted" id="profile-color-label">
        {t('sidebar.profileColor')}
      </span>
      <div role="radiogroup" aria-labelledby="profile-color-label" className="flex flex-wrap items-center gap-2">
        {swatch(undefined, t('sidebar.profileColorAuto'))}
        {PROFILE_COLORS.map((c, i) => swatch(c, t('sidebar.profileColorOption', { n: i + 1 })))}
      </div>
      <p className="text-xs text-subtle">{t('sidebar.profileColorHint')}</p>
    </div>
  )
}
