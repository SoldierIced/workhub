import { cn } from '../../lib/cn'
import { shortcutKeys, shortcutLabel, type Shortcut } from '../../lib/shortcuts'
import { usePlatform } from '../../lib/platform'

/** A keyboard shortcut with the platform's modifier: ⌘ on macOS, Ctrl on Windows and Linux. */
export function Kbd({ shortcut, className }: { shortcut: Shortcut; className?: string }) {
  const platform = usePlatform()
  return (
    <kbd aria-label={shortcutLabel(shortcut, platform)} className={cn('inline-flex items-center gap-0.5 font-sans text-xs text-subtle', className)}>
      {shortcutKeys(shortcut, platform).map((k) => (
        <span key={k} aria-hidden className="min-w-[1.1em] text-center">
          {k}
        </span>
      ))}
    </kbd>
  )
}
