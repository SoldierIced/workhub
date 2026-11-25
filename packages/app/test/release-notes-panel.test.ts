import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { OPEN_VERSIONS, ReleaseNotesPanel } from '../src/renderer/components/organisms/ReleaseNotesPanel'
import type { ReleaseNotesEntry } from '../src/shared/release-notes'
import type { UpdateStatus } from '../src/shared/updates-api'

const entry = (version: string, kind: 'new' | 'improved' | 'fixed' = 'new'): ReleaseNotesEntry => ({
  version,
  date: '2026-01-15',
  items: [{ kind, title: { en: `Title of ${version}`, es: `Título de ${version}` }, body: { en: `What ${version} is for.`, es: `Para qué sirve ${version}.` } }]
})
const available = (over: Partial<UpdateStatus>): UpdateStatus => ({ state: 'available', currentVersion: '1.0.0', version: '1.0.3', canInstall: true, changesUrl: 'https://example.com/releases', ...over })
const panel = (status: UpdateStatus) => renderToStaticMarkup(createElement(ReleaseNotesPanel, { status }))

describe('the notes of the update found', () => {
  it('lists each version with its date and each item with its kind, title and sentence', () => {
    const html = panel(available({ notes: [entry('1.0.3', 'fixed'), entry('1.0.2', 'improved')] }))
    expect(html).toContain('1.0.3')
    expect(html).toContain('Jan 15, 2026')
    expect(html).toContain('Fixed')
    expect(html).toContain('Improved')
    expect(html).toContain('Title of 1.0.2')
    expect(html).toContain('What 1.0.2 is for.')
    expect(html).not.toContain('data-testid="release-notes-earlier"')
    expect(html).toContain('See all the changes on GitHub')
  })

  it('opens the newest versions and keeps the earlier ones behind one control', () => {
    const notes = ['1.0.5', '1.0.4', '1.0.3', '1.0.2'].map((v) => entry(v))
    const html = panel(available({ notes }))
    expect(html.match(/data-testid="release-notes-version"/g)).toHaveLength(OPEN_VERSIONS)
    expect(html).toContain(`Show ${notes.length - OPEN_VERSIONS} earlier versions`)
    expect(html).not.toContain('Title of 1.0.2')
  })

  it('shows the notes as text, never as markup', () => {
    const notes = [entry('1.0.3')]
    notes[0]!.items[0]!.title.en = '<img src=x onerror=alert(1)> **bold**'
    const html = panel(available({ notes }))
    expect(html).not.toContain('<img')
    expect(html).toContain('**bold**')
  })

  it('leaves only the link when the release has no notes, and says so when they could not be read', () => {
    const none = panel(available({}))
    expect(none).toContain('data-testid="release-notes-link"')
    expect(none).not.toContain('data-testid="release-notes"')
    expect(none).not.toContain('could not be loaded')
    expect(panel(available({ notesError: true }))).toContain('The list of changes could not be loaded.')
    expect(panel(available({ changesUrl: undefined }))).toBe('')
  })
})
