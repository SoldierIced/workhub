import { describe, expect, it } from 'vitest'
import { showMainOnActivate } from '../src/main/activation'

describe('activating the app (Cmd+Tab, Dock)', () => {
  it('leaves a visible window (Settings) in front and brings the main window back only when none is visible', () => {
    expect(showMainOnActivate(true)).toBe(false)
    expect(showMainOnActivate(false)).toBe(true)
  })
})
