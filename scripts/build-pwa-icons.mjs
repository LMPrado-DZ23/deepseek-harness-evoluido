// Generates the PWA icons of the Studio interface from the official logo.
// Run once when the logo changes: `node scripts/build-pwa-icons.mjs`. The
// outputs are committed so the build never needs the image toolchain.
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(resolve(process.cwd(), 'plugins/prompt-to-app/package.json'))
const sharp = require('sharp')
const source = resolve(process.cwd(), 'apps/studio-web/public/brand/dz23-studio-logo.jpg')
const target = resolve(process.cwd(), 'apps/studio-web/public/icons')
await mkdir(target, { recursive: true })
const background = { r: 255, g: 255, b: 255, alpha: 1 }
for (const [name, size, padding] of [['icon-192.png', 192, 0], ['icon-512.png', 512, 0], ['maskable-512.png', 512, 0.2]]) {
  const inner = Math.round(size * (1 - padding))
  const logo = await sharp(source).resize({ width: inner, height: inner, fit: 'contain', background }).png().toBuffer()
  const offset = Math.round((size - inner) / 2)
  const image = await sharp({ create: { width: size, height: size, channels: 4, background } })
    .composite([{ input: logo, left: offset, top: offset }]).png({ compressionLevel: 9 }).toBuffer()
  await writeFile(resolve(target, name), image)
  process.stdout.write(`${name} ${String(image.byteLength)} bytes\n`)
}
