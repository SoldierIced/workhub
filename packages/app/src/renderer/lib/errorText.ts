import { translate } from '../i18n/translate'

/**
 * An error as text that is safe to show: the Electron IPC prefix is dropped, and anything that
 * looks like a dumped validation error or JSON becomes a plain sentence in the app's language.
 */
export function errorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  const message = raw.replace(/^Error invoking remote method '[^']*':\s*(\w*Error:\s*)?/, '').trim()
  if (/ZodError/.test(raw) || /^[[{]/.test(message) || /"code"\s*:/.test(message)) {
    const lang = typeof document === 'undefined' ? 'en' : document.documentElement.lang
    return translate(lang === 'es' ? 'es' : 'en', 'error.unexpected')
  }
  return message
}
