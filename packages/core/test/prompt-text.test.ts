import { describe, expect, it } from 'vitest'
import { promptTitle, resolveSessionName, stripPromptWrappers } from '../src'

describe('stripPromptWrappers', () => {
  it('keeps the pasted text and drops the paste tags', () => {
    expect(stripPromptWrappers('<pasted_content id="3d5d">\nReview the PR\nsecond line\n</pasted_content>')).toBe('Review the PR\nsecond line')
  })

  it('keeps the text typed around a paste', () => {
    expect(stripPromptWrappers('why is this failing?\n\n<pasted_content id="e812">\nError: boom\n</pasted_content>')).toBe('why is this failing?\n\nError: boom')
  })

  it('handles a paste cut off by the first-prompt length limit', () => {
    expect(stripPromptWrappers('<pasted_content id="3d5d">\nReview the')).toBe('Review the')
    expect(stripPromptWrappers('<pasted_content id="3d')).toBe('')
  })

  it('drops harness blocks with their content', () => {
    expect(stripPromptWrappers('<system-reminder>be brief</system-reminder>\nfix the login')).toBe('fix the login')
    expect(stripPromptWrappers('<command-name>/clear</command-name>\n<command-args></command-args>')).toBe('')
    expect(stripPromptWrappers('<system-reminder>never closed')).toBe('')
  })

  it('leaves plain text alone', () => {
    expect(stripPromptWrappers('use <T> in the signature')).toBe('use <T> in the signature')
  })
})

describe('promptTitle', () => {
  it('uses the first meaningful line of the inner text', () => {
    expect(promptTitle('\n\n<pasted_content id="4528">\n\nReview   two merged PRs\nmore\n</pasted_content>')).toBe('Review two merged PRs')
  })

  it('caps the length', () => {
    expect(promptTitle(`<pasted_content id="1">${'x'.repeat(100)}</pasted_content>`)).toBe(`${'x'.repeat(59)}…`)
    expect(promptTitle('x'.repeat(100), 20)).toBe(`${'x'.repeat(19)}…`)
  })

  it('is undefined when nothing readable is left', () => {
    expect(promptTitle('<pasted_content id="3d5d">')).toBeUndefined()
    expect(promptTitle('<pasted_content id="3d5d">\n</pasted_content>')).toBeUndefined()
    expect(promptTitle(undefined)).toBeUndefined()
  })
})

describe('resolveSessionName with a pasted first prompt', () => {
  it('names the session after the pasted text', () => {
    expect(resolveSessionName({ firstPrompt: '<pasted_content id="3d5d">\nfix the build', cwd: '/w/api' })).toEqual({ title: 'fix the build', titled: true })
  })

  it('falls back to the folder when the prompt holds only a wrapper', () => {
    expect(resolveSessionName({ firstPrompt: '<pasted_content id="3d5d">', cwd: '/w/api' })).toEqual({ title: 'api', titled: false })
  })
})
