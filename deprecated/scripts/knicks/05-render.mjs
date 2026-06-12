import path from "node:path"
import fs from "node:fs/promises"
import { createCanvas, loadImage } from "@napi-rs/canvas"
import sharp from "sharp"

import { CONFIG } from "./config.mjs"
import { clamp, ensureDir, readJson, removeDir, run } from "./lib/common.mjs"
import { ensureReferenceImage } from "./lib/media.mjs"
import {
  cellWorldRect,
  intersects,
  planMosaicLayout,
  screenRectForCell,
  zoomWindow,
} from "./lib/viewport.mjs"

function hashInt(n) {
  let x = n | 0
  x = x ^ 61 ^ (x >>> 16)
  x = x + (x << 3)
  x = x ^ (x >>> 4)
  x = Math.imul(x, 0x27d4eb2d)
  x = x ^ (x >>> 15)
  return x >>> 0
}

// Each tile starts at a staggered point in its clip and plays at normal speed,
// so tiles reach their matched (final) frame at different times and then hold.
// The mosaic resolves into a sharp still progressively instead of all at once,
// and reused clips no longer play in lockstep.
function frameForClip(clip, globalTime, cellIndex = 0) {
  const { preRollSec, tileFps, playStartStagger } = CONFIG.mosaic
  const last = Math.max(0, clip.frames.length - 1)
  if (globalTime >= preRollSec) {
    return clip.frames[last]
  }
  const stagger = playStartStagger ?? 0
  const startFrame =
    stagger > 0
      ? Math.round(stagger * ((hashInt(cellIndex) % 1000) / 1000) * last)
      : 0
  const index = clamp(startFrame + Math.floor(globalTime * tileFps), 0, last)
  return clip.frames[index]
}

function drawCover(ctx, image, x, y, w, h) {
  const scale = Math.max(w / image.width, h / image.height)
  const sw = w / scale
  const sh = h / scale
  const sx = (image.width - sw) / 2
  const sy = (image.height - sh) / 2
  ctx.drawImage(image, sx, sy, sw, sh, x, y, w, h)
}

// The cache persists across render frames: each tile image is used by ~fps /
// tileFps consecutive frames, so carrying it over avoids re-reading and
// re-decoding every visible tile from disk on every frame. After a frame is
// rendered the caller evicts entries the frame no longer needs (tile playback
// only moves forward), keeping memory bounded to one frame's working set.
async function loadFrameCache(framePaths, cache) {
  for (const framePath of framePaths) {
    if (!cache.has(framePath)) {
      const buffer = await fs.readFile(framePath)
      try {
        cache.set(framePath, await loadImage(buffer))
      } catch (error) {
        try {
          cache.set(
            framePath,
            await loadImage(await sharp(buffer).png().toBuffer())
          )
        } catch {
          throw new Error(`Failed to load frame ${framePath}: ${error.message}`)
        }
      }
    }
  }
  return cache
}

function evictUnused(cache, needed) {
  for (const key of cache.keys()) {
    if (!needed.has(key)) cache.delete(key)
  }
}

async function renderFrame({
  ctx,
  frameIndex,
  clipsByKey,
  frameCache,
  plan,
  rect,
}) {
  const { outputWidth, outputHeight, fps, preRollSec } = CONFIG.mosaic
  const time = frameIndex / fps
  const window =
    time >= preRollSec
      ? { x: 0, y: 0, w: outputWidth, h: outputHeight }
      : zoomWindow(time, rect)

  ctx.fillStyle = "#050505"
  ctx.fillRect(0, 0, outputWidth, outputHeight)

  for (const assignment of plan.assignments) {
    if (!intersects(cellWorldRect(assignment, rect), window)) continue
    const clip = clipsByKey.get(assignment.candidateKey)
    if (!clip) continue
    const framePath = frameForClip(clip, time, assignment.cellIndex)
    const image = frameCache.get(framePath)
    if (!image) continue

    const screen = screenRectForCell(assignment, window, rect)
    drawCover(ctx, image, screen.x, screen.y, screen.w + 0.5, screen.h + 0.5)
  }

  // JPEG intermediates: ~5-10x faster to encode than 4K PNGs, and x264
  // re-encodes them anyway so the quality difference doesn't survive.
  return ctx.canvas.encode("jpeg", 95)
}

async function encodeFromFrameDir() {
  const { fps, crf, encodePreset } = CONFIG.mosaic
  const tmpOutputPath = CONFIG.paths.outputVideoPath.replace(
    /\.mp4$/,
    ".tmp.mp4"
  )
  await ensureDir(path.dirname(CONFIG.paths.outputVideoPath))
  await run(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-framerate",
      String(fps),
      "-i",
      path.join(CONFIG.paths.renderFramesDir, "frame_%04d.jpg"),
      "-vf",
      "format=yuv420p",
      "-c:v",
      "libx264",
      "-preset",
      encodePreset,
      "-crf",
      String(crf),
      "-movflags",
      "+faststart",
      tmpOutputPath,
    ],
    { quiet: true }
  )
  await fs.rename(tmpOutputPath, CONFIG.paths.outputVideoPath)
}

async function main() {
  const [plan, clipsManifest] = await Promise.all([
    readJson(CONFIG.paths.matchPath),
    readJson(CONFIG.paths.clipsPath),
  ])
  if (!plan?.assignments?.length) {
    throw new Error("Missing match plan. Run pnpm knicks:match first.")
  }
  if (!clipsManifest?.clips?.length) {
    throw new Error("Missing extracted clips. Run pnpm knicks:clips first.")
  }

  await ensureReferenceImage()
  await removeDir(CONFIG.paths.renderFramesDir)
  await ensureDir(CONFIG.paths.renderFramesDir)

  const rect = planMosaicLayout(plan)
  const clipsByKey = new Map(
    clipsManifest.clips.map((clip) => [clip.key, clip])
  )
  const canvas = createCanvas(
    CONFIG.mosaic.outputWidth,
    CONFIG.mosaic.outputHeight
  )
  const ctx = canvas.getContext("2d")
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = "high"
  const totalFrames = Math.round(
    (CONFIG.mosaic.preRollSec + CONFIG.mosaic.freezeSec) * CONFIG.mosaic.fps
  )

  const frameCache = new Map()
  // Every frame at time >= preRollSec is identical (full window, every clip
  // held on its final frame), so render the first one and copy it after that.
  let freezeFramePath = null

  for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
    const time = frameIndex / CONFIG.mosaic.fps
    const outPath = path.join(
      CONFIG.paths.renderFramesDir,
      `frame_${String(frameIndex + 1).padStart(4, "0")}.jpg`
    )

    if (time >= CONFIG.mosaic.preRollSec && freezeFramePath) {
      await fs.copyFile(freezeFramePath, outPath)
      continue
    }

    const window =
      time >= CONFIG.mosaic.preRollSec
        ? {
            x: 0,
            y: 0,
            w: CONFIG.mosaic.outputWidth,
            h: CONFIG.mosaic.outputHeight,
          }
        : zoomWindow(time, rect)
    const framePaths = new Set()
    for (const assignment of plan.assignments) {
      if (!intersects(cellWorldRect(assignment, rect), window)) continue
      const clip = clipsByKey.get(assignment.candidateKey)
      if (clip) framePaths.add(frameForClip(clip, time, assignment.cellIndex))
    }
    await loadFrameCache(framePaths, frameCache)
    const jpeg = await renderFrame({
      ctx,
      frameIndex,
      clipsByKey,
      frameCache,
      plan,
      rect,
    })
    await fs.writeFile(outPath, jpeg)
    evictUnused(frameCache, framePaths)
    if (time >= CONFIG.mosaic.preRollSec) {
      freezeFramePath = outPath
    }
    if (frameIndex % CONFIG.mosaic.fps === 0) {
      console.log(
        `Rendered ${Math.round(time)}s / ${Math.round(totalFrames / CONFIG.mosaic.fps)}s`
      )
    }
  }

  await encodeFromFrameDir()

  await run(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-ss",
      String(CONFIG.mosaic.preRollSec),
      "-i",
      CONFIG.paths.outputVideoPath,
      "-frames:v",
      "1",
      CONFIG.paths.posterPath,
    ],
    { quiet: true }
  )

  console.log(`Wrote ${CONFIG.paths.outputVideoPath}`)
  console.log(`Wrote ${CONFIG.paths.posterPath}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
