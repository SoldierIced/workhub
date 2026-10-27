import { describe, expect, it } from 'vitest'
import { appTokens, contrast, findTerminalTheme, isDarkTheme, mix, searchTerminalThemes, TERMINAL_THEMES, terminalFontStack, xtermTheme } from '../src/renderer/lib/terminalThemes'
import { resolveAppearance } from '../src/renderer/lib/appearance'

describe('terminal themes', () => {
  it('bundle the Workhub 1 catalog with complete palettes', () => {
    expect(TERMINAL_THEMES.length).toBeGreaterThan(400)
    for (const th of TERMINAL_THEMES) {
      expect(th.background).toMatch(/^#[0-9a-f]{6}$/)
      expect(th.foreground).toMatch(/^#[0-9a-f]{6}$/)
      expect(th.palette).toHaveLength(16)
    }
    expect(new Set(TERMINAL_THEMES.map((th) => th.name)).size).toBe(TERMINAL_THEMES.length)
  })

  it('find by exact name and search case-insensitively', () => {
    expect(findTerminalTheme('Catppuccin Mocha')?.background).toBe('#1e1e2e')
    expect(findTerminalTheme('')).toBeUndefined()
    expect(searchTerminalThemes('CATPPUCCIN').map((th) => th.name)).toContain('Catppuccin Latte')
    expect(searchTerminalThemes('').length).toBe(TERMINAL_THEMES.length)
  })

  it('tell dark from light and map the ANSI palette to xterm', () => {
    const latte = findTerminalTheme('Catppuccin Latte')!
    const mocha = findTerminalTheme('Catppuccin Mocha')!
    expect(isDarkTheme(latte)).toBe(false)
    expect(isDarkTheme(mocha)).toBe(true)
    const x = xtermTheme(mocha)
    expect(x.background).toBe(mocha.background)
    expect(x.red).toBe(mocha.palette[1])
    expect(x.brightWhite).toBe(mocha.palette[15])
  })

  it('derive readable app tokens from a theme', () => {
    for (const name of ['Catppuccin Mocha', 'Catppuccin Latte', 'Solarized Light', 'Dracula']) {
      const th = findTerminalTheme(name)
      if (!th) continue
      const tokens = appTokens(th)
      expect(tokens['--wh-bg']).toBe(th.background)
      expect(contrast(tokens['--wh-accent']!, th.background)).toBeGreaterThanOrEqual(3)
      expect(contrast(tokens['--wh-text']!, th.background)).toBeGreaterThan(3)
    }
  })

  it('mix colors and build a font stack', () => {
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080')
    expect(terminalFontStack('', 'monospace')).toBe('monospace')
    expect(terminalFontStack('Fira Code', 'monospace')).toBe('"Fira Code", monospace')
  })

  it('let a theme that colors the app decide light or dark', () => {
    expect(resolveAppearance({ theme: 'dark', themeApp: true, terminalTheme: 'Catppuccin Latte' }, true)).toBe('light')
    expect(resolveAppearance({ theme: 'dark', themeApp: false, terminalTheme: 'Catppuccin Latte' }, true)).toBe('dark')
    expect(resolveAppearance({ theme: 'system', themeApp: true, terminalTheme: '' }, false)).toBe('light')
  })
})
