import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { CONFIG } from "./config.mjs"
import {
  ensureDir,
  exists,
  readJson,
  removeDir,
  shortHash,
  writeJson,
} from "./lib/common.mjs"
import {
  coverFrameSizeForSource,
  extractVideoFrames,
  probeVideo,
} from "./lib/media.mjs"
import { maxScreenSizeForCandidate } from "./lib/grid.mjs"
import { decodeGeometry } from "./lib/contour.mjs"

const CLIP_CONCURRENCY = Math.max(
  1,
  Number(process.env.MOSAIC_CLIPS_CONCURRENCY) ||
    Math.floor((os.availableParallelism?.() ?? os.cpus().length) / 2)
)

async function runPool(items, concurrency, fn) {
  let cursor = 0
  const worker = async () => {
    for (;;) {
      const i = cursor++
      if (i >= items.length) return
      await fn(items[i], i)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker)
  )
}

async function frameList(dir) {
  const files = await fs.readdir(dir).catch(() => [])
  return files
    .filter((file) => /^frame_\d+\.jpg$/i.test(file))
    .sort()
    .map((file) => path.join(dir, file))
}

async function sourceSizeFor(candidate) {
  if (candidate.sourceWidth && candidate.sourceHeight) {
    return {
      width: candidate.sourceWidth,
      height: candidate.sourceHeight,
    }
  }
  return await probeVideo(candidate.videoPath)
}

function clipCacheKey(candidate, size) {
  return shortHash(
    JSON.stringify({
      schemaVersion: 1,
      sourceHash: candidate.sourceHash,
      keyT: Number(candidate.keyT).toFixed(3),
      startT: Number(candidate.startT).toFixed(3),
      matchAtSec: Number(candidate.matchAtSec).toFixed(3),
      preRollSec: CONFIG.mosaic.preRollSec,
      tileFps: CONFIG.mosaic.tileFps,
      width: size.width,
      height: size.height,
    })
  )
}

async function cachedFrames(cacheDir, cacheKey) {
  const metaPath = path.join(cacheDir, "meta.json")
  const meta = await readJson(metaPath)
  if (!meta || meta.cacheKey !== cacheKey) return null
  const frames = await frameList(cacheDir)
  return frames.length ? frames : null
}

async function extractCandidate(candidate, plan, geometry) {
  if (!(await exists(candidate.videoPath))) {
    throw new Error(`Source video for ${candidate.key} is missing: ${candidate.videoPath}`)
  }
  const targetBox = maxScreenSizeForCandidate(plan, candidate.key, geometry)
  const sourceSize = await sourceSizeFor(candidate)
  const size = coverFrameSizeForSource(sourceSize, targetBox)
  const cacheKey = clipCacheKey(candidate, size)
  const cacheDir = path.join(CONFIG.paths.clipCacheDir, cacheKey)
  const cached = await cachedFrames(cacheDir, cacheKey)
  if (cached) {
    return {
      ...candidate,
      cacheKey,
      dir: cacheDir,
      frames: cached,
      width: size.width,
      height: size.height,
      sourceWidth: sourceSize.width,
      sourceHeight: sourceSize.height,
      cacheHit: true,
    }
  }

  await removeDir(cacheDir)
  await ensureDir(cacheDir)
  // Add one tile frame so the exact matched frame is available for freezing.
  const duration = candidate.matchAtSec + 1 / CONFIG.mosaic.tileFps
  await extractVideoFrames({
    videoPath: candidate.videoPath,
    startT: candidate.startT,
    duration,
    fps: CONFIG.mosaic.tileFps,
    width: size.width,
    height: size.height,
    outDir: cacheDir,
  })
  const frames = await frameList(cacheDir)
  if (!frames.length) {
    throw new Error(`ffmpeg produced no frames for ${candidate.key}`)
  }
  await writeJson(path.join(cacheDir, "meta.json"), {
    cacheKey,
    candidateKey: candidate.key,
    sourceHash: candidate.sourceHash,
    videoPath: candidate.videoPath,
    startT: candidate.startT,
    keyT: candidate.keyT,
    matchAtSec: candidate.matchAtSec,
    preRollSec: CONFIG.mosaic.preRollSec,
    tileFps: CONFIG.mosaic.tileFps,
    width: size.width,
    height: size.height,
    frameCount: frames.length,
    generatedAt: new Date().toISOString(),
  })
  return {
    ...candidate,
    cacheKey,
    dir: cacheDir,
    frames,
    width: size.width,
    height: size.height,
    sourceWidth: sourceSize.width,
    sourceHeight: sourceSize.height,
    cacheHit: false,
  }
}

async function main() {
  const plan = await readJson(CONFIG.paths.matchPath)
  if (!plan?.usedCandidates?.length) {
    throw new Error("Missing match plan. Run node 02-match.mjs first.")
  }
  await ensureDir(CONFIG.paths.clipCacheDir)

  console.log(
    `Preparing ${plan.usedCandidates.length} clip sequences with concurrency ${CLIP_CONCURRENCY}`
  )
  const geometry = plan.geometry ? decodeGeometry(plan.geometry) : null
  const clips = new Array(plan.usedCandidates.length)
  let done = 0
  let cacheHits = 0
  await runPool(plan.usedCandidates, CLIP_CONCURRENCY, async (candidate, i) => {
    clips[i] = await extractCandidate(candidate, plan, geometry)
    if (clips[i].cacheHit) cacheHits++
    done++
    const status = clips[i].cacheHit ? "cache" : "extract"
    console.log(
      `[${done}/${plan.usedCandidates.length}] ${status} ${candidate.key} ` +
        `${clips[i].width}x${clips[i].height}`
    )
  })

  await writeJson(CONFIG.paths.clipsManifestPath, {
    schemaVersion: 1,
    profile: CONFIG.profileName,
    generatedAt: new Date().toISOString(),
    planPath: CONFIG.paths.matchPath,
    cacheHits,
    clips: clips.map(({ cacheHit, ...clip }) => clip),
  })
  console.log(
    `Prepared ${clips.length} clip sequences (${cacheHits} cache hits). Wrote ${CONFIG.paths.clipsManifestPath}`
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
