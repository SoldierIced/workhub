import { Info } from 'lucide-react'
import type { ReactNode } from 'react'
import { Tooltip } from '../../components/atoms'
import { Card } from '../../components/molecules'
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

/** A Settings section: a heading (with optional help), its rows in a card and a footnote. */
export function SettingsGroup({ title, help, children, footnote }: { title: string; help?: ReactNode; children: ReactNode; footnote?: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="flex items-center gap-1.5 px-1 text-md font-semibold">
        {title}
        {help && <HelpTip text={help} label={title} />}
      </h2>
      <Card className="divide-y divide-border px-4">{children}</Card>
      {footnote && <p className="px-1 text-xs text-subtle">{footnote}</p>}
    </section>
  )
}

/** A label on the left, its control on the right. */
export function SettingRow({ label, hint, help, children }: { label: string; hint?: ReactNode; help?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 py-3">
      <div className="min-w-0">
        <span className="flex items-center gap-1.5 text-base">
          {label}
          {help && <HelpTip text={help} label={label} />}
        </span>
        {hint && <p className="text-xs text-subtle">{hint}</p>}
      </div>
      <div className="w-56 shrink-0">{children}</div>
    </div>
  )
}
