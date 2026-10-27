#!/usr/bin/env node
/**
 * Renders logo/workhub-logo.svg into the icons electron-builder needs, in packages/app/build:
 * icon.icns (macOS), icon.ico (Windows) and icon.png + icons/<size>x<size>.png (Linux).
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
console.log(`icons written to ${out}`)
