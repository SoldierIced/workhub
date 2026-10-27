import { describe, expect, it } from 'vitest'
import { matchesShortcut, shortcutKeys, shortcutLabel } from '../src/renderer/lib/shortcuts'
import { toPlatform } from '../src/shared/api'

const key = (k: string, mods: Partial<{ meta: boolean; ctrl: boolean; shift: boolean; alt: boolean }> = {}) => ({
  key: k,
  metaKey: mods.meta ?? false,
  ctrlKey: mods.ctrl ?? false,
  shiftKey: mods.shift ?? false,
  altKey: mods.alt ?? false
})

describe('toPlatform', () => {
  it('maps Node platforms to OS families', () => {
    expect(toPlatform('darwin')).toBe('mac')
    expect(toPlatform('win32')).toBe('windows')
    expect(toPlatform('linux')).toBe('linux')
    expect(toPlatform('freebsd')).toBe('linux')
  })
})

describe('shortcut labels', () => {
  it('use ⌘ on macOS and Ctrl elsewhere', () => {
    expect(shortcutLabel({ key: '1' }, 'mac')).toBe('⌘1')
    expect(shortcutLabel({ key: '1' }, 'windows')).toBe('Ctrl+1')
    expect(shortcutLabel({ key: '1' }, 'linux')).toBe('Ctrl+1')
  })

  it('upper-case letters and keep punctuation', () => {
    expect(shortcutLabel({ key: 't' }, 'mac')).toBe('⌘T')
    expect(shortcutLabel({ key: ',' }, 'windows')).toBe('Ctrl+,')
  })

  it('order modifiers per platform convention', () => {
    expect(shortcutKeys({ key: 'n', shift: true, alt: true }, 'mac')).toEqual(['⌥', '⇧', '⌘', 'N'])
    expect(shortcutLabel({ key: 'n', shift: true, alt: true }, 'windows')).toBe('Ctrl+Alt+Shift+N')
  })
})

describe('matchesShortcut', () => {
  it('needs Command on macOS', () => {
    expect(matchesShortcut(key('1', { meta: true }), { key: '1' }, 'mac')).toBe(true)
    expect(matchesShortcut(key('1', { ctrl: true }), { key: '1' }, 'mac')).toBe(false)
  })

  it('needs Control on Windows and Linux', () => {
    expect(matchesShortcut(key('1', { ctrl: true }), { key: '1' }, 'windows')).toBe(true)
    expect(matchesShortcut(key('1', { meta: true }), { key: '1' }, 'linux')).toBe(false)
  })

  it('respects Shift and Alt and ignores letter case', () => {
    expect(matchesShortcut(key('T', { meta: true }), { key: 't' }, 'mac')).toBe(true)
    expect(matchesShortcut(key('t', { meta: true, shift: true }), { key: 't' }, 'mac')).toBe(false)
    expect(matchesShortcut(key('1', { ctrl: true, alt: true }), { key: '1' }, 'windows')).toBe(false)
    expect(matchesShortcut(key('1'), { key: '1' }, 'windows')).toBe(false)
  })
})
