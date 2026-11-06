import { useState } from 'react'
import { useI18n } from '../../i18n/I18nProvider'
import { cn } from '../../lib/cn'
import { CUSTOM_OPTION, optionOrCustomState, valueForPick, type ChoiceOption } from '../../lib/optionOrCustom'
import { Input, Select } from '../atoms'

export interface OptionOrCustomProps {
  value: string
  onChange: (value: string) => void
  /** The known choices (a model list, the effort levels). */
  options: readonly ChoiceOption[]
  /** The label of the empty choice (`''`: "Agent default"); without it there is no empty choice. */
  emptyLabel?: string
  /** Placeholder of the custom text input. */
  placeholder?: string
  /** Called when the custom input loses focus (to trim or save the typed value). */
  onCustomBlur?: () => void
  /** The id the field's label points at (set by `Field`). */
  id?: string
  'aria-label'?: string
  disabled?: boolean
  className?: string
  'data-testid'?: string
}

/**
 * A select of known values plus "Other…", which reveals a text input for any other value. A
 * stored value the list does not know shows as "Other…" with the input filled in, never dropped.
 */
export function OptionOrCustom({ value, onChange, options, emptyLabel, placeholder, onCustomBlur, id, disabled, className, ...rest }: OptionOrCustomProps) {
  const { t } = useI18n()
  // "Other…" picked while the value is still empty or a known one: keep the input open.
  const [forceCustom, setForceCustom] = useState(false)
  const state = optionOrCustomState(value, options, { allowEmpty: emptyLabel !== undefined, forceCustom })
  const list = [...(emptyLabel !== undefined ? [{ value: '', label: emptyLabel }] : []), ...options, { value: CUSTOM_OPTION, label: t('common.otherOption') }]
  const label = rest['aria-label']
  return (
    <div className={cn('flex flex-col gap-1.5', className)} data-testid={rest['data-testid']}>
      <Select
        id={id}
        aria-label={label}
        value={state.selected}
        disabled={disabled}
        onChange={(picked) => {
          setForceCustom(picked === CUSTOM_OPTION)
          const next = valueForPick(picked, value)
          if (next !== value) onChange(next)
        }}
        options={list}
      />
      {state.custom && (
        <Input
          value={value}
          disabled={disabled}
          spellCheck={false}
          autoFocus={forceCustom}
          aria-label={label ? t('common.customValueOf', { field: label }) : t('common.customValue')}
          placeholder={placeholder ?? t('common.customValuePlaceholder')}
          onChange={(e) => {
            // Typing keeps the input open, even when the text is cleared or matches a known choice.
            setForceCustom(true)
            onChange(e.target.value)
          }}
          onBlur={onCustomBlur}
          data-testid={rest['data-testid'] ? `${rest['data-testid']}-custom` : undefined}
        />
      )}
    </div>
  )
}
