import { describe, expect, it } from 'vitest'
import { en } from '../src/renderer/i18n/en'
import { es } from '../src/renderer/i18n/es'
import { prTitleParts } from '../src/web/pr-pages'
import { shortDay } from '../src/web/plan-format'

const STATUSES = ['merged', 'closed', 'conflicts', 'ciFailed', 'changesRequested', 'draft', 'approved', 'ciRunning', 'waitingReview']
const NOT_CODE_NAME = /^[a-z]+[A-Z]/

describe('pull request states in words', () => {
  it('have a label in both languages that is not the code name', () => {
    for (const status of STATUSES) {
      for (const dict of [en, es] as Record<string, string>[]) {
        const label = dict[`pr.status.${status}`]
        expect(label, status).toBeTruthy()
        expect(label, status).not.toMatch(NOT_CODE_NAME)
      }
    }
  })

  it('has every alert severity in both languages', () => {
    for (const severity of ['high', 'medium', 'low']) {
      expect((en as Record<string, string>)[`metricAlerts.severity.${severity}`]).toBeTruthy()
      expect((es as Record<string, string>)[`metricAlerts.severity.${severity}`]).toBeTruthy()
    }
    expect(es['metricAlerts.severity.high' as keyof typeof es]).not.toBe(en['metricAlerts.severity.high' as keyof typeof en])
  })
})

describe('prTitleParts', () => {
  it('moves the ticket key out of the title', () => {
    expect(prTitleParts('ACME-212 Add gift cards', false)).toEqual({ key: 'ACME-212', title: 'Add gift cards' })
    expect(prTitleParts('[ACME-7] Fix the cart', false)).toEqual({ key: 'ACME-7', title: 'Fix the cart' })
    expect(prTitleParts('ACME-7: Fix the cart', false)).toEqual({ key: 'ACME-7', title: 'Fix the cart' })
  })
  it('leaves a title without a key alone', () => {
    expect(prTitleParts('Fix the cart total', false)).toEqual({ key: null, title: 'Fix the cart total' })
    // Things that look like a key but are not one stay in the title.
    for (const t of ['UTF-8 decoding', 'HTTP-2 support', 'SHA-256 checksums', 'ISO-8601 dates']) expect(prTitleParts(t, false)).toEqual({ key: null, title: t })
  })
  it('drops the draft marker of a draft only', () => {
    expect(prTitleParts('Draft: ACME-9 Rework the form', true)).toEqual({ key: 'ACME-9', title: 'Rework the form' })
    expect(prTitleParts('[WIP] Rework the form', true)).toEqual({ key: null, title: 'Rework the form' })
    expect(prTitleParts('Draft: Rework the form', false).title).toBe('Draft: Rework the form')
  })
  it('keeps the title when nothing is left of it', () => {
    expect(prTitleParts('ACME-9', false)).toEqual({ key: null, title: 'ACME-9' })
  })
})

describe('shortDay', () => {
  const format = (ms: number, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en', o).format(ms)
  const now = new Date(2026, 10, 20).getTime()
  it('leaves the year out inside the current year', () => {
    expect(shortDay('2026-08-26', now, format)).toBe('Aug 26')
  })
  it('puts the year on a date outside it', () => {
    expect(shortDay('2027-01-15', now, format)).toBe('Jan 15, 2027')
    expect(shortDay('2025-12-31', now, format)).toBe('Dec 31, 2025')
  })
  it('returns what is not a day as it came', () => {
    expect(shortDay('soon', now, format)).toBe('soon')
  })
})
