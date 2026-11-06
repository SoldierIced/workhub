import { describe, expect, it } from 'vitest'
import { chromeColorsFrom } from '../src/main/chrome-colors'

describe('window controls overlay colors', () => {
  it('takes hex colors the renderer painted, so a terminal theme applied to the app reaches the title bar', () => {
    expect(chromeColorsFrom({ color: '#1e1e2e', symbolColor: '#cdd6f4' })).toEqual({ color: '#1e1e2e', symbolColor: '#cdd6f4' })
    expect(chromeColorsFrom({ color: '#FFF', symbolColor: '#000' })).toEqual({ color: '#FFF', symbolColor: '#000' })
  })

  it('ignores anything that is not a pair of hex colors', () => {
    expect(chromeColorsFrom(undefined)).toBeNull()
    expect(chromeColorsFrom({ color: '', symbolColor: '#000' })).toBeNull()
    expect(chromeColorsFrom({ color: 'red', symbolColor: '#000' })).toBeNull()
    expect(chromeColorsFrom({ color: '#0e1014' })).toBeNull()
    expect(chromeColorsFrom('#0e1014')).toBeNull()
  })
})
