import fs from "node:fs/promises"
import path from "node:path"

import { createCanvas, loadImage } from "@napi-rs/canvas"

import { CONFIG } from "./config.mjs"
import { captureBuffer, ensureDir, formatSeconds, readJson } from "./lib/common.mjs"
import { screenRectForCell } from "./lib/grid.mjs"
import { coverFrameSizeForSource } from "./lib/media.mjs"

function drawCover(ctx, image, x, y, w, h) {
  const scale = Math.max(w / image.width, h / image.height)
  const sw = w / scale
  const sh = h / scale
  const sx = (image.width - sw) / 2
  const sy = (image.height - sh) / 2
  ctx.drawImage(image, sx, sy, sw, sh, x, y, w, h)
}

async function extractMatchedStill(candidate, targetBox) {
  const sourceSize = {
    width: candidate.sourceWidth,
    height: candidate.sourceHeight,
  }
  const size = coverFrameSizeForSource(sourceSize, targetBox)
  const result = await captureBuffer(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      formatSeconds(candidate.keyT),
      "-i",
      candidate.videoPath,
      "-frames:v",
      "1",
      "-vf",
      [
        `scale=${size.width}:${size.height}:force_original_aspect_ratio=decrease:flags=lanczos`,
        "setsar=1",
      ].join(","),
      "-f",
      "image2pipe",
      "-vcodec",
      "png",
      "-",
    ],
    { quiet: true }
  )
  return await loadImage(result.stdout)
}

async function main() {
  const plan = await readJson(CONFIG.paths.matchPath)
  if (!plan?.assignments?.length) {
    throw new Error("Missing match plan. Run node 02-match.mjs first.")
  }
  if (!plan?.usedCandidates?.length) {
    throw new Error("Missing used candidates in match plan.")
  }

  const { outputWidth, outputHeight } = plan.grid
  const canvas = createCanvas(outputWidth, outputHeight)
  const ctx = canvas.getContext("2d")
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = "high"

  ctx.fillStyle = plan.grid.backgroundColor || "#050505"
  ctx.fillRect(0, 0, outputWidth, outputHeight)
  if (plan.referencePath) {
    const reference = await loadImage(plan.referencePath)
    ctx.drawImage(
      reference,
      0,
      0,
      reference.width,
      reference.height,
      0,
      0,
      outputWidth,
      outputHeight
    )
  }

  const candidatesByKey = new Map(
    plan.usedCandidates.map((candidate) => [candidate.key, candidate])
  )
  const imageCache = new Map()
  const targetBox = {
    width: plan.grid.cellWidth ?? outputWidth,
    height: plan.grid.cellHeight ?? outputHeight,
  }

  let drawn = 0
  for (const assignment of plan.assignments) {
    const candidate = candidatesByKey.get(assignment.candidateKey)
    if (!candidate) continue
    let image = imageCache.get(candidate.key)
    if (!image) {
      image = await extractMatchedStill(candidate, targetBox)
      imageCache.set(candidate.key, image)
    }
    const screen = screenRectForCell(
      assignment,
      { x: 0, y: 0, w: outputWidth, h: outputHeight },
      plan
    )
    drawCover(ctx, image, screen.x, screen.y, screen.w + 0.5, screen.h + 0.5)
    drawn++
    if (drawn % 50 === 0 || drawn === plan.assignments.length) {
      console.log(`Drew ${drawn}/${plan.assignments.length} poster cells`)
    }
  }

  await ensureDir(path.dirname(CONFIG.paths.posterPath))
  await fs.writeFile(CONFIG.paths.posterPath, await canvas.encode("jpeg", 95))
  console.log(`Wrote ${CONFIG.paths.posterPath}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
