import { describe, expect, it } from 'vitest'
import { en } from '../src/renderer/i18n/en'
import { es } from '../src/renderer/i18n/es'
import { interpolate, placeholders, resolveLocale, translate, translatePlural } from '../src/renderer/i18n/translate'

describe('dictionaries', () => {
  const enKeys = Object.keys(en).sort()
  const esKeys = Object.keys(es).sort()

  it('have exactly the same keys in English and Spanish', () => {
    expect(esKeys).toEqual(enKeys)
  })

  it('have no empty message', () => {
    for (const [locale, dict] of Object.entries({ en, es })) {
      for (const [key, value] of Object.entries(dict)) expect(value.trim(), `${locale} ${key}`).not.toBe('')
    }
  })

  it('use the same placeholders in both languages', () => {
    for (const key of enKeys) {
      expect(placeholders(es[key as keyof typeof en]), key).toEqual(placeholders(en[key as keyof typeof en]))
    }
  })

  it('define both plural forms for every plural message', () => {
    for (const key of enKeys) {
      const m = /^(.*)\.(one|other)$/.exec(key)
      if (!m) continue
      expect(enKeys, key).toContain(`${m[1]}.one`)
      expect(enKeys, key).toContain(`${m[1]}.other`)
    }
  })
})

describe('resolveLocale', () => {
  it('uses the explicit preference', () => {
    expect(resolveLocale('es', ['en-US'])).toBe('es')
    expect(resolveLocale('en', ['es-AR'])).toBe('en')
  })

  it('follows the first supported OS language', () => {
    expect(resolveLocale('system', ['es-419', 'en-US'])).toBe('es')
    expect(resolveLocale('system', ['fr-FR', 'es_ES'])).toBe('es')
    expect(resolveLocale('system', ['en-GB'])).toBe('en')
  })

  it('falls back to English', () => {
    expect(resolveLocale('system', ['fr-FR', 'de'])).toBe('en')
    expect(resolveLocale('system', [])).toBe('en')
  })
})

describe('translate', () => {
  it('fills placeholders and leaves unknown ones visible', () => {
    expect(interpolate('Hello {name}', { name: 'Acme' })).toBe('Hello Acme')
    expect(interpolate('Hello {name}', {})).toBe('Hello {name}')
  })

  it('translates per locale', () => {
    expect(translate('en', 'nav.settings')).toBe('Settings')
    expect(translate('es', 'nav.settings')).toBe('Ajustes')
    expect(translate('es', 'chat.imageAlt', { n: 3 })).toBe('Imagen pegada 3')
  })

  it('picks the plural form', () => {
    expect(translatePlural('en', 'home.sessionsWaiting', 1)).toBe('1 session waiting')
    expect(translatePlural('en', 'home.sessionsWaiting', 3)).toBe('3 sessions waiting')
    expect(translatePlural('es', 'home.sessionsWaiting', 0)).toBe('0 sesiones en espera')
    expect(translatePlural('es', 'home.sessionsWaiting', 1)).toBe('1 sesión en espera')
  })
})
