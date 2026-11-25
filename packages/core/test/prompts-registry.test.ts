import { describe, expect, it } from 'vitest'
import { configSchema } from '../src/config/schema'
import { cleanPromptOverrides, fillPrompt, MAX_PROMPT_LENGTH, placeholdersIn, PROMPT_IDS, PROMPTS, promptIssuesOf, promptSavable, promptTemplate, withPromptOverride, type PromptDefinition, type PromptId } from '../src/prompts'

const def: PromptDefinition = { area: 'review', placeholders: ['title', 'round', 'brief'], slots: ['brief'], defaultText: 'Review {title}, round {round}.\n\n{brief}' }

describe('prompt registry', () => {
  it('every id is unique and every default uses only its placeholders and keeps its slots', () => {
    for (const id of PROMPT_IDS) {
      const d: PromptDefinition = PROMPTS[id]
      for (const text of [d.defaultText, d.defaultEs].filter((t): t is string => t !== undefined)) {
        const issues = promptIssuesOf(d, text)
        expect(issues.unknown, id).toEqual([])
        expect(issues.missingSlots, id).toEqual([])
      }
      for (const slot of d.slots ?? []) expect(d.placeholders, id).toContain(slot)
    }
  })

  it('uses the user text when there is one, else the localized default, else the English one', () => {
    const id = 'x' as PromptId
    const own = { x: 'Mine' }
    expect(promptTemplate(own, id, 'Localizado')).toBe('Mine')
    expect(promptTemplate({ x: '   ' }, id, 'Localizado')).toBe('Localizado')
    expect(promptTemplate(undefined, id, 'Localizado')).toBe('Localizado')
  })

  it('fills known placeholders and leaves the others as written', () => {
    expect(fillPrompt('Review {title} ({round}) {other}', { title: 'Fix login', round: 2 })).toBe('Review Fix login (2) {other}')
    expect(fillPrompt('{a}{a}', { a: '$&' })).toBe('$&$&')
    expect(placeholdersIn('{a} {b} {a}')).toEqual(['a', 'b'])
  })

  it('refuses unknown placeholders and dropped slots, and only warns for a dropped optional one', () => {
    const typo = promptIssuesOf(def, 'Review {titel}\n{brief}')
    expect(typo.unknown).toEqual(['titel'])
    expect(promptSavable(typo, 'x')).toBe(false)
    const noSlot = promptIssuesOf(def, 'Review {title}')
    expect(noSlot.missingSlots).toEqual(['brief'])
    expect(promptSavable(noSlot, 'x')).toBe(false)
    const short = promptIssuesOf(def, 'Just review.\n{brief}')
    expect(short).toEqual({ unknown: [], missingSlots: [], missingOptional: ['title', 'round'] })
    expect(promptSavable(short, 'x')).toBe(true)
    expect(promptSavable(short, 'x'.repeat(MAX_PROMPT_LENGTH + 1))).toBe(false)
  })

  it('stores only a text that differs from the default shown', () => {
    expect(withPromptOverride({ a: 'old' }, 'x', 'Mine', 'Default')).toEqual({ a: 'old', x: 'Mine' })
    expect(withPromptOverride({ x: 'Mine' }, 'x', 'Default', 'Default')).toEqual({})
    expect(withPromptOverride({ x: 'Mine' }, 'x', '  ', 'Default')).toEqual({})
  })

  it('cleans stored overrides entry by entry', () => {
    expect(cleanPromptOverrides({ a: 'ok', b: ' ', c: 'x'.repeat(MAX_PROMPT_LENGTH + 1), d: 3 })).toEqual({ a: 'ok' })
    expect(cleanPromptOverrides(['a'])).toBeUndefined()
    expect(cleanPromptOverrides('a')).toBeUndefined()
    expect(cleanPromptOverrides({ b: '' })).toBeUndefined()
  })

  it('loads a config with a bad prompt entry without losing the rest, and keeps texts of prompts this version does not know', () => {
    const parsed = configSchema.parse({ version: 8, options: { confirmQuit: false, prompts: { 'later.prompt': 'Mine', other: 5 } } })
    expect(parsed.options?.confirmQuit).toBe(false)
    expect(parsed.options?.prompts).toEqual({ 'later.prompt': 'Mine' })
  })
})
