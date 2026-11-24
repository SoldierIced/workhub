import { configSchema, promptDefinition, PROMPT_IDS } from '@workhub/core'
import { describe, expect, it } from 'vitest'
import { DICTIONARIES } from '../src/renderer/i18n/translate'
import { overridesFor, shownDefault, shownTexts, unsavable } from '../src/renderer/lib/promptSettings'

describe('Settings → Prompts', () => {
  it('names every prompt and says when it is sent, in both languages', () => {
    for (const id of PROMPT_IDS) {
      for (const part of ['name', 'when'] as const) {
        const key = `prompts.${id}.${part}`
        expect(Object.hasOwn(DICTIONARIES.en, key), key).toBe(true)
        expect(Object.hasOwn(DICTIONARIES.es, key), key).toBe(true)
      }
    }
  })

  it('shows the default in the UI language: the screen text, the Spanish table, else English', () => {
    expect(shownDefault('links.ticket', 'es')).toBe(DICTIONARIES.es['links.prompt.ticket'])
    expect(shownDefault('review.prOpinion', 'es')).toBe(promptDefinition('review.prOpinion').defaultEs)
    expect(shownDefault('continuity.summaryAsk', 'es')).toBe(promptDefinition('continuity.summaryAsk').defaultText)
  })

  it('stores only edited texts and drops one put back to its default', () => {
    const texts = shownTexts(undefined, 'en')
    expect(unsavable(texts, 'en')).toEqual([])
    expect(overridesFor(undefined, texts, 'en')).toEqual({})
    const edited = { ...texts, 'continuity.continueAfterLimit': 'Go on where you stopped.' }
    expect(overridesFor(undefined, edited, 'en')).toEqual({ 'continuity.continueAfterLimit': 'Go on where you stopped.' })
    const stored = { 'continuity.continueAfterLimit': 'Old' }
    expect(overridesFor(stored, { ...shownTexts(stored, 'en'), 'continuity.continueAfterLimit': texts['continuity.continueAfterLimit'] }, 'en')).toEqual({})
    expect(shownTexts({ 'continuity.continueAfterLimit': 'Old' }, 'en')['continuity.continueAfterLimit']).toBe('Old')
  })

  it('keeps a stored text equal to the default of the language shown when another prompt is saved', () => {
    const esDefault = shownTexts(undefined, 'es')['review.prOpinion']
    const stored = { 'review.prOpinion': esDefault }
    const shown = shownTexts(stored, 'es')
    const next = overridesFor(stored, { ...shown, 'continuity.continueAfterLimit': 'Go on.' }, 'es')
    expect(next).toEqual({ 'review.prOpinion': esDefault, 'continuity.continueAfterLimit': 'Go on.' })
  })

  it('refuses a text that drops a slot or names an unknown placeholder', () => {
    const texts = shownTexts(undefined, 'en')
    const bad = unsavable({ ...texts, 'links.fixCi': 'Fix CI on {name}.', 'links.ticket': 'Ticket {titel}' }, 'en')
    expect(bad.map((b) => b.id).sort()).toEqual(['links.fixCi', 'links.ticket'])
    expect(bad.find((b) => b.id === 'links.fixCi')!.issues.missingSlots).toEqual(['data'])
  })

  it('keeps every stored text in config.json, also of a prompt this version does not know, when another one is saved', () => {
    const stored = configSchema.parse({ version: 8, options: { prompts: { 'continuity.continueAfterLimit': 'Go on.', 'later.prompt': 'Mine' } } }).options?.prompts
    expect(stored).toEqual({ 'continuity.continueAfterLimit': 'Go on.', 'later.prompt': 'Mine' })
    const texts = shownTexts(stored, 'en')
    expect(overridesFor(stored, { ...texts, 'listen.system': 'Short.' }, 'en')).toEqual({ 'continuity.continueAfterLimit': 'Go on.', 'later.prompt': 'Mine', 'listen.system': 'Short.' })
  })
})
