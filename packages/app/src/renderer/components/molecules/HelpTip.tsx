import { Info } from 'lucide-react'
import type { ReactNode } from 'react'
import { Tooltip } from '../atoms/Tooltip'
import { useI18n } from '../../i18n/I18nProvider'

/** A small (i) button whose tooltip explains a setting; focusable, so keyboard users get it too. */
export function HelpTip({ text, label }: { text: ReactNode; label?: string }) {
  const { t } = useI18n()
  return (
    <Tooltip content={<span className="block max-w-72 leading-snug">{text}</span>}>
      <button
        type="button"
        aria-label={label ? t('help.about', { name: label }) : t('help.more')}
        className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-subtle transition-colors hover:text-text focus-visible:text-text"
        onClick={(e) => e.preventDefault()}
      >
        <Info className="size-3.5" aria-hidden />
      </button>
    </Tooltip>
  )
}
