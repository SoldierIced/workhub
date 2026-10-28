import { Check, Copy } from 'lucide-react'
import { useEffect, useState } from 'react'
import { IconButton } from '../atoms'
import { useI18n } from '../../i18n/I18nProvider'
import { cn } from '../../lib/cn'

/** How long the check mark stays after a copy. */
const COPIED_MS = 1500

/** Copies `text()` to the clipboard; the icon turns into a check for a moment so the copy is seen. */
export function CopyButton({ text, className }: { text: () => string; className?: string }) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), COPIED_MS)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <IconButton
      size="sm"
      label={copied ? t('chat.copied') : t('chat.copy')}
      className={cn('size-6', className)}
      icon={copied ? <Check className="size-3.5 text-success" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
      onClick={() => {
        void navigator.clipboard.writeText(text()).then(
          () => setCopied(true),
          () => undefined
        )
      }}
      data-testid="copy-button"
    />
  )
}
