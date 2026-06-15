import fs from "node:fs/promises"
import path from "node:path"

import { createCanvas, loadImage } from "@napi-rs/canvas"

import { CONFIG } from "./config.mjs"
import {
  captureBuffer,
  clamp,
  ensureDir,
  exists,
  readJson,
  run,
  shortHash,
  writeJson,
} from "./lib/common.mjs"
import {
  cellRectFromPlan,
  intersects,
  screenRectForCell,
  zoomWindow,
} from "./lib/grid.mjs"
import { decodeGeometry } from "./lib/contour.mjs"

function hashInt(n) {
  let x = n | 0
  x = x ^ 61 ^ (x >>> 16)
  x = x + (x << 3)
  x = x ^ (x >>> 4)
  x = Math.imul(x, 0x27d4eb2d)
  x = x ^ (x >>> 15)
  return x >>> 0
}

function frameForClip(clip, globalTime, cellIndex = 0, timing, plan = null) {
  const last = Math.max(0, clip.frames.length - 1)
  const isOpeningCell = plan && cellIndex === plan.grid.openingCell
  const delay =
    !isOpeningCell && CONFIG.mosaic.tileStartDelaySec
      ? Math.min(
          Math.max(0, CONFIG.mosaic.tileStartDelaySec),
          Math.max(0, timing.preRollSec - 0.001)
        )
      : 0
  if (delay > 0 && globalTime < delay) return clip.frames[0]
  if (delay > 0 && globalTime < timing.preRollSec) {
    const startFrame =
      CONFIG.mosaic.playStartStagger > 0
        ? Math.round(
            CONFIG.mosaic.playStartStagger *
              ((hashInt(cellIndex) % 1000) / 1000) *
              last
          )
        : 0
    const maxPlayable = Math.max(0, last - startFrame)
    const progress = clamp(
      (globalTime - delay) / Math.max(0.001, timing.preRollSec - delay),
      0,
      1
    )
    const index = clamp(
      startFrame + Math.round(progress * maxPlayable),
      0,
      last
    )
    return clip.frames[index]
  }
  const matchAtSec = clip.matchAtSec ?? timing.preRollSec
  if (globalTime >= matchAtSec) return clip.frames[last]
  const stagger = CONFIG.mosaic.playStartStagger ?? 0
  const startFrame =
    stagger > 0
      ? Math.round(stagger * ((hashInt(cellIndex) % 1000) / 1000) * last)
      : 0
  const maxPlayable = Math.max(0, last - startFrame)
  const progress = clamp(globalTime / Math.max(0.001, matchAtSec), 0, 1)
  const index = clamp(
    startFrame + Math.round(progress * maxPlayable),
    0,
    last
  )
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

// Paint the reference photo so it fills the whole world rect (0,0..output),
// mapped through the current zoom window. Matched tiles are drawn on top, so
// the unmatched part of the frame stays the original picture. The reference is
// stretched to the output rect to match how the matcher samples it.
function drawReferenceBackground(ctx, image, window, plan) {
  const { outputWidth, outputHeight } = plan.grid
  const sx = ((0 - window.x) / window.w) * outputWidth
  const sy = ((0 - window.y) / window.h) * outputHeight
  const sw = (outputWidth / window.w) * outputWidth
  const sh = (outputHeight / window.h) * outputHeight
  ctx.drawImage(image, 0, 0, image.width, image.height, sx, sy, sw, sh)
}

// Fraction of a cell inset toward its centroid as grout gap, and the epsilon
// for pinning vertices that sit on the outer frame (mirrors the web engine).
const TILE_GAP = 0.125
const TILE_EDGE_EPS = 0.75

// Draw one Voronoi cell: inset its polygon for the grout gap (pinning frame
// vertices so grout only appears between tiles), clip, and cover-fill with the
// tile image rotated to the cell's contour angle. World→screen mapping happens
// per vertex so the same geometry works at every zoom level.
function drawVoronoiCell(ctx, geometry, cellIndex, image, window, plan) {
  const { polys, offsets, angles } = geometry
  const start = offsets[cellIndex]
  const end = offsets[cellIndex + 1]
  const n = end - start
  if (n < 3) return
  const { outputWidth, outputHeight } = plan.grid
  const scaleX = outputWidth / window.w
  const scaleY = outputHeight / window.h

  let sx = 0
  let sy = 0
  for (let v = start; v < end; v++) {
    sx += polys[v * 2]
    sy += polys[v * 2 + 1]
  }
  const mx = sx / n
  const my = sy / n

  const k = 1 - TILE_GAP
  const xs = new Array(n)
  const ys = new Array(n)
  let maxDist = 0
  for (let j = 0; j < n; j++) {
    const x = polys[(start + j) * 2]
    const y = polys[(start + j) * 2 + 1]
    const onLeft = x <= TILE_EDGE_EPS
    const onTop = y <= TILE_EDGE_EPS
    const onRight = Math.abs(x - outputWidth) <= TILE_EDGE_EPS
    const onBottom = Math.abs(y - outputHeight) <= TILE_EDGE_EPS
    const onFrame = onLeft || onTop || onRight || onBottom
    const px = onFrame ? (onLeft ? 0 : onRight ? outputWidth : x) : mx + (x - mx) * k
    const py = onFrame ? (onTop ? 0 : onBottom ? outputHeight : y) : my + (y - my) * k
    const spx = (px - window.x) * scaleX
    const spy = (py - window.y) * scaleY
    xs[j] = spx
    ys[j] = spy
  }
  const smx = (mx - window.x) * scaleX
  const smy = (my - window.y) * scaleY
  for (let j = 0; j < n; j++) {
    const d = Math.hypot(xs[j] - smx, ys[j] - smy)
    if (d > maxDist) maxDist = d
  }
  const cover = maxDist * 2

  ctx.save()
  ctx.beginPath()
  ctx.moveTo(xs[0], ys[0])
  for (let j = 1; j < n; j++) ctx.lineTo(xs[j], ys[j])
  ctx.closePath()
  ctx.clip()
  ctx.translate(smx, smy)
  const angle = angles[cellIndex]
  if (angle) ctx.rotate(angle)
  drawCover(ctx, image, -cover / 2, -cover / 2, cover, cover)
  ctx.restore()
}

async function loadFrameImage(framePath) {
  const buffer = await fs.readFile(framePath)
  try {
    return await loadImage(buffer)
  } catch (primaryError) {
    try {
      const png = await captureBuffer(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-i",
          framePath,
          "-frames:v",
          "1",
          "-f",
          "image2pipe",
          "-vcodec",
          "png",
          "-",
        ],
        { quiet: true }
      )
      return await loadImage(png.stdout)
    } catch (fallbackError) {
      throw new Error(
        `Failed to decode render frame ${framePath}: ${primaryError.message}; ` +
          `ffmpeg PNG fallback failed: ${fallbackError.message}`
      )
    }
  }
}

async function loadFrameCache(framePaths, cache) {
  for (const framePath of framePaths) {
    if (!cache.has(framePath)) {
      cache.set(framePath, await loadFrameImage(framePath))
    }
  }
}

function evictUnused(cache, needed) {
  for (const key of cache.keys()) {
    if (!needed.has(key)) cache.delete(key)
  }
}

function renderHash(plan, clipsManifest) {
  return shortHash(
    JSON.stringify({
      schemaVersion: 1,
      assignments: plan.assignments.map((assignment) => ({
        cellIndex: assignment.cellIndex,
        candidateKey: assignment.candidateKey,
      })),
      clips: clipsManifest.clips.map((clip) => ({
        key: clip.key,
        cacheKey: clip.cacheKey,
      })),
      timing: plan.timing,
      grid: plan.grid,
      geometryHash: plan.geometry ? shortHash(JSON.stringify(plan.geometry)) : null,
      reference: plan.grid.referenceBackground ? plan.referencePath : null,
      output: {
        crf: CONFIG.mosaic.crf,
        encodePreset: CONFIG.mosaic.encodePreset,
        zoomMode: "constant-factor",
        zoomDurationSec: CONFIG.mosaic.zoomDurationSec,
        zoomHoldSec: CONFIG.mosaic.zoomHoldSec,
        tileStartDelaySec: CONFIG.mosaic.tileStartDelaySec,
      },
    })
  )
}

function renderDurationSec(plan) {
  const configuredZoomDuration = CONFIG.mosaic.zoomDurationSec || 0
  if (configuredZoomDuration > 0) {
    return Math.min(configuredZoomDuration, plan.timing.preRollSec)
  }
  return plan.timing.preRollSec + plan.timing.freezeSec
}

async function renderFrame({
  ctx,
  frameIndex,
  plan,
  geometry,
  clipsByKey,
  frameCache,
  referenceImage = null,
}) {
  const time = frameIndex / plan.timing.fps
  const window = zoomWindow(time, plan, geometry)
  ctx.fillStyle = plan.grid.backgroundColor || "#050505"
  ctx.fillRect(0, 0, plan.grid.outputWidth, plan.grid.outputHeight)
  if (referenceImage) {
    drawReferenceBackground(ctx, referenceImage, window, plan)
  }

  for (const assignment of plan.assignments) {
    const worldRect = cellRectFromPlan(assignment, plan, geometry)
    if (!intersects(worldRect, window)) continue
    const clip = clipsByKey.get(assignment.candidateKey)
    if (!clip) continue
    const framePath = frameForClip(clip, time, assignment.cellIndex, plan.timing, plan)
    const image = frameCache.get(framePath)
    if (!image) continue
    if (geometry) {
      drawVoronoiCell(ctx, geometry, assignment.cellIndex, image, window, plan)
    } else {
      const screen = screenRectForCell(assignment, window, plan)
      drawCover(ctx, image, screen.x, screen.y, screen.w + 0.5, screen.h + 0.5)
    }
  }

  return ctx.canvas.encode("jpeg", 95)
}

async function encodeFromFrameDir(frameDir) {
  await ensureDir(path.dirname(CONFIG.paths.outputVideoPath))
  const tmpOutputPath = CONFIG.paths.outputVideoPath.replace(/\.mp4$/, ".tmp.mp4")
  await run(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-framerate",
      String(CONFIG.mosaic.fps),
      "-i",
      path.join(frameDir, "frame_%05d.jpg"),
      "-vf",
      "format=yuv420p",
      "-c:v",
      "libx264",
      "-preset",
      CONFIG.mosaic.encodePreset,
      "-crf",
      String(CONFIG.mosaic.crf),
      "-movflags",
      "+faststart",
      tmpOutputPath,
    ],
    { quiet: true }
  )
  await fs.rename(tmpOutputPath, CONFIG.paths.outputVideoPath)
}

async function writePoster(timeSec) {
  await run(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-ss",
      String(timeSec),
      "-i",
      CONFIG.paths.outputVideoPath,
      "-frames:v",
      "1",
      CONFIG.paths.posterPath,
    ],
    { quiet: true }
  )
}

async function main() {
  const [plan, clipsManifest, previousMeta] = await Promise.all([
    readJson(CONFIG.paths.matchPath),
    readJson(CONFIG.paths.clipsManifestPath),
    readJson(CONFIG.paths.renderMetaPath),
  ])
  if (!plan?.assignments?.length) {
    throw new Error("Missing match plan. Run node 02-match.mjs first.")
  }
  if (!clipsManifest?.clips?.length) {
    throw new Error("Missing clips manifest. Run node 03-clips.mjs first.")
  }

  const hash = renderHash(plan, clipsManifest)
  const frameDir = path.join(CONFIG.paths.renderFramesDir, hash)
  const outputDurationSec = renderDurationSec(plan)
  const totalFrames = Math.round(outputDurationSec * plan.timing.fps)
  if (
    previousMeta?.renderHash === hash &&
    (await exists(CONFIG.paths.outputVideoPath)) &&
    (await exists(CONFIG.paths.posterPath))
  ) {
    console.log(`Render cache hit: ${CONFIG.paths.outputVideoPath}`)
    return
  }

  await ensureDir(frameDir)
  const geometry = plan.geometry ? decodeGeometry(plan.geometry) : null
  const clipsByKey = new Map(clipsManifest.clips.map((clip) => [clip.key, clip]))
  const canvas = createCanvas(plan.grid.outputWidth, plan.grid.outputHeight)
  const ctx = canvas.getContext("2d")
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = "high"
  const frameCache = new Map()
  let freezeFramePath = null

  const referenceImage =
    plan.grid.referenceBackground && plan.referencePath
      ? await loadFrameImage(plan.referencePath)
      : null

  // Fast iteration: render just the final still composition to the poster.
  if (CONFIG.mosaic.previewPoster) {
    const time = outputDurationSec
    const frameIndex = Math.round(time * plan.timing.fps)
    const window = zoomWindow(time, plan, geometry)
    const framePaths = new Set()
    for (const assignment of plan.assignments) {
      const worldRect = cellRectFromPlan(assignment, plan, geometry)
      if (!intersects(worldRect, window)) continue
      const clip = clipsByKey.get(assignment.candidateKey)
      if (!clip) continue
      framePaths.add(frameForClip(clip, time, assignment.cellIndex, plan.timing, plan))
    }
    await loadFrameCache(framePaths, frameCache)
    const jpeg = await renderFrame({
      ctx,
      frameIndex,
      plan,
      geometry,
      clipsByKey,
      frameCache,
      referenceImage,
    })
    await ensureDir(path.dirname(CONFIG.paths.posterPath))
    await fs.writeFile(CONFIG.paths.posterPath, jpeg)
    console.log(`Wrote preview poster ${CONFIG.paths.posterPath}`)
    return
  }

  // Resume support: keep frames from an interrupted run, but drop the
  // highest-numbered one since it may have been partially written.
  const existingFrames = (await fs.readdir(frameDir).catch(() => []))
    .filter((file) => /^frame_\d+\.jpg$/i.test(file))
    .sort()
  const hasAllFrames = existingFrames.length >= totalFrames
  if (!hasAllFrames && existingFrames.length > 0) {
    await fs.rm(path.join(frameDir, existingFrames.pop()), { force: true })
    console.log(`Resuming render: ${existingFrames.length} frames already done`)
  }
  const existingSet = new Set(existingFrames)
  if (!hasAllFrames) {
    for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
      const time = frameIndex / plan.timing.fps
      const frameName = `frame_${String(frameIndex + 1).padStart(5, "0")}.jpg`
      const outPath = path.join(frameDir, frameName)
      if (existingSet.has(frameName)) {
        if (time >= plan.timing.preRollSec && !freezeFramePath) {
          freezeFramePath = outPath
        }
        continue
      }
      if (time >= plan.timing.preRollSec && freezeFramePath) {
        await fs.copyFile(freezeFramePath, outPath)
        continue
      }

      const window = zoomWindow(time, plan, geometry)
      const framePaths = new Set()
      for (const assignment of plan.assignments) {
        const worldRect = cellRectFromPlan(assignment, plan, geometry)
        if (!intersects(worldRect, window)) continue
        const clip = clipsByKey.get(assignment.candidateKey)
        if (!clip) continue
        framePaths.add(frameForClip(clip, time, assignment.cellIndex, plan.timing, plan))
      }
      await loadFrameCache(framePaths, frameCache)
      const jpeg = await renderFrame({
        ctx,
        frameIndex,
        plan,
        geometry,
        clipsByKey,
        frameCache,
        referenceImage,
      })
      await fs.writeFile(outPath, jpeg)
      evictUnused(frameCache, framePaths)
      if (time >= plan.timing.preRollSec) freezeFramePath = outPath
      if (frameIndex % plan.timing.fps === 0) {
        console.log(
          `Rendered ${Math.round(time)}s / ${Math.round(totalFrames / plan.timing.fps)}s`
        )
      }
    }
  } else {
    console.log(`Frame cache hit: ${frameDir}`)
  }

  await encodeFromFrameDir(frameDir)
  await writePoster(Math.max(0, outputDurationSec - 1 / plan.timing.fps))
  await writeJson(CONFIG.paths.renderMetaPath, {
    renderHash: hash,
    frameDir,
    outputVideoPath: CONFIG.paths.outputVideoPath,
    posterPath: CONFIG.paths.posterPath,
    outputDurationSec,
    totalFrames,
    generatedAt: new Date().toISOString(),
  })
  console.log(`Wrote ${CONFIG.paths.outputVideoPath}`)
  console.log(`Wrote ${CONFIG.paths.posterPath}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
