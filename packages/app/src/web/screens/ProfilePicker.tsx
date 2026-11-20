import { Check, ChevronDown } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ConfigSnapshot } from '../../shared/api'
import { useI18n } from '../../renderer/i18n/I18nProvider'
import { cn } from '../../renderer/lib/cn'

/** A profile's colour as a dot, so the profile in use is recognised without reading its name. */
function Dot({ color }: { color: string | undefined }) {
  return <span aria-hidden className="size-2.5 shrink-0 rounded-full border border-border-strong" style={{ background: color ?? 'var(--wh-text-subtle)' }} />
}

/**
 * The profile a list screen shows: a chip with the profile's colour and its name (cut with an
 * ellipsis when long) that opens a bottom sheet listing every profile in full. Hidden with a
 * single profile.
 */
export function ProfilePicker({ config, value, onChange }: { config: ConfigSnapshot | null; value: string | null; onChange: (id: string | null) => void }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const profiles = config?.config.profiles ?? []
  const chip = useRef<HTMLButtonElement>(null)
  const sheet = useRef<HTMLDivElement>(null)
  // The sheet is a modal dialog: focus moves into it (to the profile in use), Tab stays inside it, Escape closes it, and the chip gets the focus back.
  useEffect(() => {
    if (!open) return
    const trigger = chip.current
    const dialog = sheet.current
    const buttons = () => Array.from(dialog?.querySelectorAll<HTMLButtonElement>('button') ?? [])
    ;(dialog?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]') ?? buttons()[0] ?? dialog)?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return setOpen(false)
      if (e.key !== 'Tab') return
      const all = buttons()
      const first = all[0]
      const last = all[all.length - 1]
      if (!first || !last) return e.preventDefault()
      const at = document.activeElement
      if (!dialog?.contains(at)) {
        e.preventDefault()
        first.focus()
      } else if (e.shiftKey && at === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && at === last) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      trigger?.focus()
    }
  }, [open])
  if (profiles.length < 2) return null
  const current = profiles.find((p) => p.id === value) ?? profiles[0]!
  return (
    <>
      <button
        ref={chip}
        type="button"
        data-testid="profile-chip"
        aria-haspopup="dialog"
        aria-label={`${t('web.new.profile')}: ${current.name}`}
        onClick={() => setOpen(true)}
        className="flex min-h-11 max-w-40 min-w-11 items-center gap-2 rounded-full border border-border-strong bg-surface px-3 text-sm text-text active:bg-surface-hover"
      >
        <Dot color={current.color} />
        <span className="min-w-0 flex-1 truncate">{current.name}</span>
        <ChevronDown className="size-4 shrink-0 text-muted" aria-hidden />
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/50" onClick={() => setOpen(false)}>
          <div ref={sheet} tabIndex={-1} role="dialog" aria-modal="true" aria-label={t('web.new.profile')} data-testid="profile-sheet" onClick={(e) => e.stopPropagation()} className="safe-bottom max-h-[80%] overflow-y-auto outline-none rounded-t-2xl border-t border-border bg-surface-raised pt-2 shadow-lg">
            <div className="px-4 py-2 text-xs font-semibold tracking-wide text-muted uppercase">{t('web.new.profile')}</div>
            <ul>
              {profiles.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    aria-pressed={p.id === current.id}
                    onClick={() => {
                      onChange(p.id)
                      setOpen(false)
                    }}
                    className={cn('flex min-h-12 w-full items-center gap-3 px-4 py-2 text-left text-md active:bg-surface-hover', p.id === current.id && 'font-semibold')}
                  >
                    <Dot color={p.color} />
                    <span className="min-w-0 flex-1 break-words">{p.name}</span>
                    {p.id === current.id && <Check className="size-5 shrink-0 text-accent" aria-hidden />}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </>
  )
}
