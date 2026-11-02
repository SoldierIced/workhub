import { describe, expect, it } from 'vitest'
import { readUpdatePromptState, shouldPromptUpdate, UPDATE_PROMPT_INTERVAL_MS } from '../src/main/update-prompt'

const day = UPDATE_PROMPT_INTERVAL_MS
const now = 1_800_000_000_000

describe('the update prompt', () => {
  it('shows once a day for a version found', () => {
    expect(shouldPromptUpdate({}, '2.0.1', now)).toBe(true)
    expect(shouldPromptUpdate({ lastPromptAt: now - day + 1 }, '2.0.1', now)).toBe(false)
    expect(shouldPromptUpdate({ lastPromptAt: now - day }, '2.0.1', now)).toBe(true)
    // A clock moved back does not silence it for good.
    expect(shouldPromptUpdate({ lastPromptAt: now + day }, '2.0.1', now)).toBe(true)
    expect(shouldPromptUpdate({}, undefined, now)).toBe(false)
  })

  it('never shows for a skipped version, but does for a newer one', () => {
    expect(shouldPromptUpdate({ skippedVersion: '2.0.1' }, '2.0.1', now)).toBe(false)
    expect(shouldPromptUpdate({ skippedVersion: '2.0.1' }, '2.0.2', now)).toBe(true)
  })

  it('reads the stored state defensively', () => {
    expect(readUpdatePromptState({ lastPromptAt: 5, skippedVersion: '2.0.1' })).toEqual({ lastPromptAt: 5, skippedVersion: '2.0.1' })
    expect(readUpdatePromptState({ lastPromptAt: 'x', skippedVersion: '' })).toEqual({})
    expect(readUpdatePromptState(null)).toEqual({})
  })
})
