import { cn } from '../../lib/cn'

/** Up to two initials of a display name ("Ana López" -> "AL", "luis" -> "L"); "?" when empty. */
export function initials(name: string): string {
  const words = name
    .replace(/\(.*?\)/g, ' ')
    .split(/[\s._-]+/)
    .filter((w) => /\p{L}|\p{N}/u.test(w))
  if (!words.length) return '?'
  const first = words[0]!.match(/\p{L}|\p{N}/u)?.[0] ?? ''
  const last = words.length > 1 ? (words.at(-1)!.match(/\p{L}|\p{N}/u)?.[0] ?? '') : ''
  return (first + last).toUpperCase()
}

/** A stable hue (0-359) per name, so a person keeps their color everywhere. */
export function hueOf(name: string): number {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) % 360
  return h
}

/** A round initials badge for a person (chat authors). Decorative: the name is always shown next to it. */
export function Avatar({ name, size = 'md', className }: { name: string; size?: 'sm' | 'md'; className?: string }) {
  const hue = hueOf(name)
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full bg-[hsl(var(--avatar-hue)_55%_50%/0.18)] font-semibold text-[hsl(var(--avatar-hue)_60%_34%)] select-none dark:text-[hsl(var(--avatar-hue)_65%_70%)]',
        size === 'sm' ? 'size-5 text-2xs' : 'size-8 text-xs',
        className
      )}
      style={{ ['--avatar-hue' as string]: String(hue) }}
    >
      {initials(name)}
    </span>
  )
}
