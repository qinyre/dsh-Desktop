// Regenerate app icons from build/icon-source.png:
//   build/icon.ico      — multi-size (16-256) Windows app/installer icon
//   resources/icon.png  — 256px tray/window icon
//   build/icon.png      — 512px Linux packaging icon (electron-builder linux.icon)
// Run after replacing the source: npm run icons
import sharp from 'sharp'
import pngToIco from 'png-to-ico'
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const src = fileURLToPath(new URL('../build/icon-source.png', import.meta.url))
const icoOut = fileURLToPath(new URL('../build/icon.ico', import.meta.url))
const pngOut = fileURLToPath(new URL('../resources/icon.png', import.meta.url))
const linuxOut = fileURLToPath(new URL('../build/icon.png', import.meta.url))
const sizes = [16, 24, 32, 48, 64, 128, 256]
const resized = await Promise.all(sizes.map((size) =>
  sharp(src).resize(size, size, { kernel: 'lanczos3' }).png().toBuffer(),
))
await writeFile(icoOut, await pngToIco(resized))
await writeFile(pngOut, await sharp(src).resize(256, 256).png().toBuffer())
await writeFile(linuxOut, await sharp(src).resize(512, 512).png().toBuffer())
console.log('icons written: build/icon.ico (16-256) + resources/icon.png (256) + build/icon.png (512, linux)')
