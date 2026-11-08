import { useEffect } from 'react'
import { BASE_TEXT_SIZE, usePrefs } from '../renderer/lib/prefs'

/** The phone reads a bit larger than the desktop at the same preference. */
export const PHONE_TEXT_SCALE = 1.15

/** Text size choices offered on the phone, as desktop `textSize` values. */
export const TEXT_SIZE_CHOICES = [
  { key: 'small', size: 12 },
  { key: 'normal', size: BASE_TEXT_SIZE },
  { key: 'large', size: 15 },
  { key: 'xl', size: 17 }
] as const

/** Paints the theme and text size from the phone's own preferences (Settings), following the system when asked. */
export function useAppearance(): void {
  const prefs = usePrefs()
  useEffect(() => {
    const dark = matchMedia('(prefers-color-scheme: dark)')
    const paint = () => {
      document.documentElement.dataset['theme'] = prefs.theme === 'system' ? (dark.matches ? 'dark' : 'light') : prefs.theme
      document.documentElement.style.setProperty('--wh-text-scale', String((PHONE_TEXT_SCALE * prefs.textSize) / BASE_TEXT_SIZE))
    }
    paint()
    dark.addEventListener('change', paint)
    return () => dark.removeEventListener('change', paint)
  }, [prefs.theme, prefs.textSize])
}
