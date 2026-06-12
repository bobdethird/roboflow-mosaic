// Audit the color diversity of the extracted photo-frame library:
//
//   pnpm knicks:photo-report
//
// Prints a luminance histogram, a saturation histogram, and the per-video
// contribution to the dark (<64) and bright (>=160) bands so it's obvious which
// sources supply the rare tiles. Run it after photo-frames to confirm new
// sources actually filled the gaps before publishing with photo-seed.

import fs from "node:fs/promises"
import path from "node:path"

import sharp from "sharp"

import { CONFIG } from "./config.mjs"
import { exists, readJson } from "./lib/common.mjs"

const SAMPLE = 8 // 8×8 downsample per frame is plenty for a mean color read
const DARK_MAX = 64
const BRIGHT_MIN = 160

function bar(fraction, width = 40) {
  return "#".repeat(Math.round(fraction * width)).padEnd(width)
}

async function frameStats(file) {
  const { data, info } = await sharp(file)
    .resize(SAMPLE, SAMPLE, { fit: "cover" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  let lum = 0
  let sat = 0
  const n = SAMPLE * SAMPLE
  for (let i = 0; i < n; i++) {
    const o = i * info.channels
    const r = data[o]
    const g = data[o + 1]
    const b = data[o + 2]
    lum += 0.299 * r + 0.587 * g + 0.114 * b
    const max = Math.max(r, g, b)
    sat += max === 0 ? 0 : (max - Math.min(r, g, b)) / max
  }
  return { lum: lum / n, sat: sat / n }
}

async function main() {
  const root = CONFIG.paths.photoFramesDir
  if (!(await exists(root))) {
    console.error(`No frames in ${root}. Run pnpm knicks:photo-frames first.`)
    process.exit(1)
  }
  const sources = await readJson(CONFIG.paths.sourcesPath, { videos: [] })
  const tiers = new Map(sources.videos.map((video) => [video.id, video.tier]))

  const dirs = (await fs.readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))

  const lumBuckets = new Array(8).fill(0)
  const satBuckets = new Array(4).fill(0)
  const perVideo = []
  let total = 0

  for (const dir of dirs) {
    const dirPath = path.join(root, dir)
    const files = (await fs.readdir(dirPath)).filter((name) =>
      name.toLowerCase().endsWith(".jpg")
    )
    let dark = 0
    let bright = 0
    for (const name of files) {
      const { lum, sat } = await frameStats(path.join(dirPath, name))
      lumBuckets[Math.min(7, Math.floor(lum / 32))]++
      satBuckets[Math.min(3, Math.floor(sat * 4))]++
      if (lum < DARK_MAX) dark++
      if (lum >= BRIGHT_MIN) bright++
      total++
    }
    perVideo.push({ id: dir, tier: tiers.get(dir) ?? "?", frames: files.length, dark, bright })
  }

  if (total === 0) {
    console.error("No frames found.")
    process.exit(1)
  }

  console.log(`${total} frames across ${dirs.length} videos\n`)

  console.log("Luminance (0=black, 255=white)")
  lumBuckets.forEach((count, i) => {
    const lo = String(i * 32).padStart(3)
    console.log(
      `  ${lo}-${i * 32 + 31}  ${bar(count / total)} ${count} (${((100 * count) / total).toFixed(1)}%)`
    )
  })

  console.log("\nSaturation (0=gray, 1=vivid)")
  satBuckets.forEach((count, i) => {
    console.log(
      `  ${(i / 4).toFixed(2)}-${((i + 1) / 4).toFixed(2)}  ${bar(count / total)} ${count} (${((100 * count) / total).toFixed(1)}%)`
    )
  })

  const darkTotal = perVideo.reduce((sum, video) => sum + video.dark, 0)
  const brightTotal = perVideo.reduce((sum, video) => sum + video.bright, 0)
  console.log(
    `\nDark tiles (<${DARK_MAX}): ${darkTotal} (${((100 * darkTotal) / total).toFixed(1)}%)  ` +
      `Bright tiles (>=${BRIGHT_MIN}): ${brightTotal} (${((100 * brightTotal) / total).toFixed(1)}%)`
  )

  console.log("\nPer-video contribution (dark / bright / frames)")
  for (const video of perVideo.sort((a, b) => b.dark + b.bright - (a.dark + a.bright))) {
    console.log(
      `  [${video.tier}] ${video.id}: ${video.dark} dark, ${video.bright} bright, ${video.frames} frames`
    )
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
