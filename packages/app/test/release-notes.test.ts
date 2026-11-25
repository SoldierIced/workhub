import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RELEASE_NOTES_FILE, RELEASE_NOTES_LIMITS, compareVersions, notesBetween, parseReleaseNotes, type ReleaseNotesEntry } from '../src/shared/release-notes'

const text = (en: string, es = `${en} (es)`) => ({ en, es })
const entry = (version: string, items: unknown[] = [{ kind: 'new', title: text('Something new') }]) => ({ version, date: '2026-01-15', items })

describe('compareVersions', () => {
  it('orders by semver precedence: alpha numbers, alpha below beta, a pre-release below its version', () => {
    const ascending = ['1.9.9', '2.0.0-alpha.2', '2.0.0-alpha.10', '2.0.0-alpha.beta', '2.0.0-beta.1', '2.0.0-beta.1.1', '2.0.0', '2.0.1', '2.1.0', '10.0.0']
    for (let i = 1; i < ascending.length; i++) {
      expect(compareVersions(ascending[i - 1]!, ascending[i]!), `${ascending[i - 1]} < ${ascending[i]}`).toBeLessThan(0)
      expect(compareVersions(ascending[i]!, ascending[i - 1]!)).toBeGreaterThan(0)
    }
    expect(compareVersions('2.0.0-alpha.3', 'v2.0.0-alpha.3')).toBe(0)
  })

  it('does not rank what is not a version', () => {
    expect(compareVersions('latest', '2.0.0')).toBeUndefined()
    expect(compareVersions('2.0.0', '2.0')).toBeUndefined()
  })
})

describe('parseReleaseNotes', () => {
  it('reads the releases with their items in both languages', () => {
    const raw = { releases: [entry('2.0.0', [{ kind: 'fixed', title: text('A fix'), body: text('What it fixes.') }, { kind: 'improved', title: text('Faster') }])] }
    expect(parseReleaseNotes(raw)).toEqual(raw.releases)
  })

  it('drops what it cannot show instead of failing: an unknown kind, a missing language, a text over its limit', () => {
    const long = 'x'.repeat(RELEASE_NOTES_LIMITS.title + 1)
    const raw = {
      releases: [
        entry('2.0.0', [
          { kind: 'new', title: text('Kept') },
          { kind: 'breaking', title: text('Unknown kind') },
          { kind: 'new', title: { en: 'Only English' } },
          { kind: 'new', title: text(long) },
          { kind: 'new', title: text('Body too long'), body: text('y'.repeat(RELEASE_NOTES_LIMITS.body + 1)) }
        ]),
        entry('not a version'),
        entry('1.9.0', [{ kind: 'new', title: { en: '', es: '' } }]),
        'nonsense'
      ]
    }
    expect(parseReleaseNotes(raw)).toEqual([entry('2.0.0', [{ kind: 'new', title: text('Kept') }])])
  })

  it('reads nothing from something that is not the file', () => {
    for (const raw of [null, 'text', [], {}, { releases: 'none' }]) expect(parseReleaseNotes(raw)).toEqual([])
  })

  it('keeps no more items per release and no more releases than the limits', () => {
    const items = Array.from({ length: RELEASE_NOTES_LIMITS.items + 3 }, (_, i) => ({ kind: 'new', title: text(`Item ${i}`) }))
    const releases = Array.from({ length: RELEASE_NOTES_LIMITS.releases + 5 }, (_, i) => entry(`1.0.${i}`, items))
    const parsed = parseReleaseNotes({ releases })
    expect(parsed).toHaveLength(RELEASE_NOTES_LIMITS.releases)
    expect(parsed[0]!.items).toHaveLength(RELEASE_NOTES_LIMITS.items)
  })
})

describe('notesBetween', () => {
  const entries = parseReleaseNotes({ releases: ['2.0.0-alpha.7', '2.0.0-alpha.4', '2.0.0-alpha.6', '2.0.0-alpha.5'].map((v) => entry(v)) })
  const versions = (list: ReleaseNotesEntry[]) => list.map((e) => e.version)

  it('gives every version after the running one up to the one found, newest first', () => {
    expect(versions(notesBetween(entries, '2.0.0-alpha.4', '2.0.0-alpha.6'))).toEqual(['2.0.0-alpha.6', '2.0.0-alpha.5'])
  })

  it('gives nothing when the version found is not newer or a version cannot be read', () => {
    expect(notesBetween(entries, '2.0.0-alpha.7', '2.0.0-alpha.7')).toEqual([])
    expect(notesBetween(entries, 'dev', '2.0.0-alpha.7')).toEqual([])
  })

  it('shows the newest versions only when someone is far behind', () => {
    const many = parseReleaseNotes({ releases: Array.from({ length: 20 }, (_, i) => entry(`1.0.${i}`)) })
    const shown = notesBetween(many, '0.9.0', '1.0.19')
    expect(shown).toHaveLength(RELEASE_NOTES_LIMITS.shown)
    expect(shown[0]!.version).toBe('1.0.19')
  })
})

describe('release-notes.json of this repository', () => {
  const root = join(__dirname, '..', '..', '..')
  const file = readFileSync(join(root, RELEASE_NOTES_FILE), 'utf8')
  const raw = JSON.parse(file) as { releases: ReleaseNotesEntry[] }

  it('is valid as written: nothing is dropped, cut or reordered by the app', () => {
    expect(parseReleaseNotes(raw)).toEqual(raw.releases)
    expect(Buffer.byteLength(file)).toBeLessThan(RELEASE_NOTES_LIMITS.bytes)
  })

  it('lists the releases newest first, each version once', () => {
    for (let i = 1; i < raw.releases.length; i++) {
      expect(compareVersions(raw.releases[i - 1]!.version, raw.releases[i]!.version), `${raw.releases[i - 1]!.version} comes before ${raw.releases[i]!.version}`).toBeGreaterThan(0)
    }
  })

  // The release pull request bumps the version: its checks stay red until the notes for it exist
  // (CONTRIBUTING.md, Releases).
  it('has the notes of the version in package.json', () => {
    const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }
    expect(raw.releases.map((r) => r.version), `release-notes.json has no entry for ${version}: write it in English and Spanish before releasing`).toContain(version)
  })
})
