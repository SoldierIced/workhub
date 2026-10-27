import { describe, expect, it } from 'vitest'
import { showWorkhub1Migration, showWorkhub1Tokens } from '../src/renderer/lib/workhub1'

const pending = [{ connectionId: 'jira-acme', name: 'Jira (acme)' }]

describe('Workhub 1 migration visibility', () => {
  it('shows the migration section only on macOS when Workhub 1 settings were found', () => {
    expect(showWorkhub1Migration('mac', { available: true })).toBe(true)
    expect(showWorkhub1Migration('mac', { available: false })).toBe(false)
    expect(showWorkhub1Migration('mac', { available: false, error: 'boom' })).toBe(false)
    expect(showWorkhub1Migration('mac', null)).toBe(false)
    expect(showWorkhub1Migration('win', { available: true })).toBe(false)
    expect(showWorkhub1Migration('linux', { available: true })).toBe(false)
  })

  it('shows the token import only while a Workhub 1 connection is missing its token', () => {
    expect(showWorkhub1Tokens('mac', { available: true, pendingSecrets: pending })).toBe(true)
    expect(showWorkhub1Tokens('mac', { available: true, pendingSecrets: [] })).toBe(false)
    expect(showWorkhub1Tokens('mac', { available: true })).toBe(false)
    expect(showWorkhub1Tokens('mac', { available: false, pendingSecrets: pending })).toBe(false)
    expect(showWorkhub1Tokens('linux', { available: true, pendingSecrets: pending })).toBe(false)
  })
})
