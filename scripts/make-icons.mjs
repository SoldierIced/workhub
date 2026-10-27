#!/usr/bin/env node
/**
 * Renders logo/workhub-logo.svg into the icons electron-builder needs, in packages/app/build:
 * icon.icns (macOS), icon.ico (Windows) and icon.png + icons/<size>x<size>.png (Linux).
 * It also renders the tray icons into packages/app/build/tray (shipped as extra resources):
 * - trayTemplate.png / trayTemplate@2x.png: macOS menu bar template images from
 *   logo/menubar-glyph.svg (Workhub 1's MenuBarIcon): black and alpha only, so macOS tints them
 *   for light and dark menu bars.
 * - tray.ico / tray-attention.ico: Windows notification area (16 to 48 px), the color logo; the
 *   attention variant adds an orange dot.
 * - tray.png / tray-attention.png: Linux status icon (AppIndicator ignores template images and
 *   scales the image to the panel), the color logo at 32 px.
 * The outputs are committed, so a build does not need to run this; run it when the logo changes
 * (`npm run icons`).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import png2icons from 'png2icons'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'packages', 'app', 'build')
const svg = readFileSync(join(root, 'logo', 'workhub-logo.svg'))
mkdirSync(join(out, 'icons'), { recursive: true })

const render = (size) => sharp(svg, { density: 384 }).resize(size, size).png().toBuffer()

// macOS icons keep the transparent margin around the squircle (it is part of the template);
// Windows and Linux icons are cropped to the squircle so they do not look small.
const mac = await render(1024)
const tight = await sharp(svg, { density: 384 })
  .resize(1024, 1024)
  .extract({ left: 100, top: 100, width: 824, height: 824 })
  .resize(1024, 1024)
  .png()
  .toBuffer()

writeFileSync(join(out, 'icon.png'), tight)
const icns = png2icons.createICNS(mac, png2icons.BILINEAR, 0)
const ico = png2icons.createICO(tight, png2icons.BICUBIC, 0, false, true)
if (!icns || !ico) throw new Error('png2icons could not build the icon files')
writeFileSync(join(out, 'icon.icns'), icns)
writeFileSync(join(out, 'icon.ico'), ico)
for (const size of [16, 32, 48, 64, 128, 256, 512, 1024]) {
  const buf = await sharp(tight).resize(size, size).png().toBuffer()
  writeFileSync(join(out, 'icons', `${size}x${size}.png`), buf)
}

// Tray icons.
const tray = join(out, 'tray')
mkdirSync(tray, { recursive: true })
const glyph = await sharp(readFileSync(join(root, 'logo', 'menubar-glyph.svg')), { density: 384 }).resize(1024, 1024).png().toBuffer()
const trimmed = await sharp(glyph).trim().png().toBuffer()
// Workhub 1 draws the glyph 15 points tall in a 17-point slot; here 16 of 18 points.
for (const [scale, suffix] of [[1, ''], [2, '@2x']]) {
  const box = 18 * scale
  const inner = await sharp(trimmed).resize({ width: 16 * scale, height: 16 * scale, fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer()
  const template = await sharp({ create: { width: box, height: box, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: inner, gravity: 'center' }])
    .png()
    .toBuffer()
  writeFileSync(join(tray, `trayTemplate${suffix}.png`), template)
}
const dot = (size) => {
  const r = Math.round(size * 0.22)
  const c = size - r - 1
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><circle cx="${c}" cy="${c}" r="${r}" fill="#f59e0b" stroke="#ffffff" stroke-width="${Math.max(1, Math.round(size / 32))}"/></svg>`)
}
const colored = async (size, attention) => {
  const base = sharp(tight).resize(size, size)
  return (attention ? base.composite([{ input: dot(size) }]) : base).png().toBuffer()
}
for (const attention of [false, true]) {
  const name = attention ? 'tray-attention' : 'tray'
  writeFileSync(join(tray, `${name}.png`), await colored(32, attention))
  const big = await colored(256, attention)
  const trayIco = png2icons.createICO(big, png2icons.BICUBIC, 0, true, false)
  if (!trayIco) throw new Error('png2icons could not build the tray icon')
  writeFileSync(join(tray, `${name}.ico`), trayIco)
}
console.log(`icons written to ${out}`)
