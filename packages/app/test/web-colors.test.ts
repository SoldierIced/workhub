import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const webCss = read('../src/web/web.css')
const rendererCss = read('../src/renderer/styles.css')

/** The value of a custom property in the light theme's block of a stylesheet. */
function light(css: string, selector: RegExp, name: string): string {
  const block = selector.exec(css)?.[1] ?? ''
  const value = new RegExp(`--wh-${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(block)?.[1]
  if (!value) throw new Error(`no --wh-${name} in the light theme`)
  return value
}

const luminance = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}

describe('the phone-only light theme colours', () => {
  const rendererLight = /\[data-theme='light'\]\s*\{([^}]*)\}/
  const phoneLight = /html:root\[data-theme='light'\]\s*\{([^}]*)\}/
  const muted = light(rendererCss, rendererLight, 'text-muted')
  const subtle = light(webCss, phoneLight, 'text-subtle')
  const surfaces = ['bg', 'sidebar', 'surface', 'surface-raised', 'surface-hover'].map((n) => light(rendererCss, rendererLight, n))

  it('keep subtle text lighter than muted text, and both readable on every surface', () => {
    for (const surface of surfaces) {
      expect(contrast(subtle, surface)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(muted, surface)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(subtle, surface)).toBeLessThan(contrast(muted, surface))
    }
  })
})
