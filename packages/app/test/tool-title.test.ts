import { describe, expect, it } from 'vitest'
import { translate, type MessageKey, type Params } from '../src/renderer/i18n/translate'
import { localizeToolTitle } from '../src/renderer/lib/toolTitle'
import { usageCeilingLabel } from '../src/renderer/lib/usage-window'

const es = (k: MessageKey, p?: Params) => translate('es', k, p)
const en = (k: MessageKey, p?: Params) => translate('en', k, p)

describe('monitor tool titles', () => {
  it('translates the adapters English shapes', () => {
    expect(localizeToolTitle('Read README.md', es)).toBe('Leyó README.md')
    expect(localizeToolTitle('Called atlassian: get jira issue', es)).toBe('Llamó a atlassian: get jira issue')
    expect(localizeToolTitle('Ran a command', es)).toBe('Ejecutó un comando')
    expect(localizeToolTitle('Searched the code for "foo"', es)).toBe('Buscó "foo" en el código')
  })
  it('keeps English as is and leaves free text alone', () => {
    expect(localizeToolTitle('Read README.md', en)).toBe('Read README.md')
    expect(localizeToolTitle('Read the logs for errors', es)).toBe('Read the logs for errors')
  })
})

describe('usage ceiling label', () => {
  it('reads mid-sentence in Spanish', () => {
    expect(usageCeilingLabel('monthly', es)).toBe('Techo mensual (%)')
    expect(usageCeilingLabel('weekly', en)).toBe('Weekly ceiling (%)')
  })
})
