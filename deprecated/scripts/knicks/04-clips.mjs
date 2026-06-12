import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import sharp from "sharp"

import { CONFIG } from "./config.mjs"
import {
  ensureDir,
  exists,
  formatSeconds,
  readJson,
  removeDir,
  run,
  writeJson,
} from "./lib/common.mjs"
import { coverFrameSizeForSource, probeVideoSize } from "./lib/media.mjs"
import { decodeGeometry } from "./lib/mosaic-node.mjs"
import { maxScreenSizeForCandidate } from "./lib/viewport.mjs"

// Each extraction is an independent single-threaded-ish ffmpeg job, so run a
// pool of them. Half the cores keeps the machine responsive while still being
// ~Nx faster than the old sequential loop.
const CLIP_CONCURRENCY = Math.max(
  1,
  Number(process.env.KNICKS_CLIPS_CONCURRENCY) ||
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
    .filter((file) => /^frame_\d+\.jpg$/.test(file))
    .sort()
    .map((file) => path.join(dir, file))
}

// Fallback for candidates whose source video is gone (the photo-frames library
// can outlive a re-scrape): a single-frame "clip" from the still itself, so the
// tile renders statically but the final mosaic keeps the matched frame.
async function stillClip(candidate, match, geometry) {
  const targetBox = maxScreenSizeForCandidate(match, geometry, candidate.key)
  const outDir = path.join(CONFIG.paths.clipsDir, candidate.key)
  await removeDir(outDir)
  await ensureDir(outDir)
  const meta = await sharp(candidate.framePath).metadata()
  const sourceSize = { width: meta.width, height: meta.height }
  const { width, height } = coverFrameSizeForSource(sourceSize, targetBox)
  const outPath = path.join(outDir, "frame_0001.jpg")
  await sharp(candidate.framePath)
    .resize(width, height, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 95 })
    .toFile(outPath)
  return {
    ...candidate,
    videoPath: null,
    sourceWidth: sourceSize.width,
    sourceHeight: sourceSize.height,
    dir: outDir,
    frames: [outPath],
    width,
    height,
    still: true,
  }
}

async function extractClip(candidate, source, match, geometry, sourceSize) {
  const targetBox = maxScreenSizeForCandidate(match, geometry, candidate.key)
  const { width, height } = coverFrameSizeForSource(sourceSize, targetBox)
  const outDir = path.join(CONFIG.paths.clipsDir, candidate.key)
  await removeDir(outDir)
  await ensureDir(outDir)

  const filter = [
    `fps=${CONFIG.mosaic.tileFps}`,
    `scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos`,
    "setsar=1",
  ].join(",")

  await run(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-ss",
      formatSeconds(candidate.startT),
      "-i",
      source.path,
      "-t",
      formatSeconds(CONFIG.mosaic.preRollSec),
      "-vf",
      filter,
      "-q:v",
      "1",
      path.join(outDir, "frame_%04d.jpg"),
    ],
    { quiet: true }
  )

  const frames = await frameList(outDir)
  if (!frames.length) {
    throw new Error(`ffmpeg produced no frames for ${candidate.key}`)
  }

  return {
    ...candidate,
    videoPath: source.path,
    sourceWidth: sourceSize.width,
    sourceHeight: sourceSize.height,
    dir: outDir,
    frames,
    width,
    height,
  }
}

async function main() {
  const [match, sources] = await Promise.all([
    readJson(CONFIG.paths.matchPath),
    readJson(CONFIG.paths.sourcesPath),
  ])
  if (!match?.usedCandidates?.length) {
    throw new Error("Missing match plan. Run pnpm knicks:match first.")
  }
  if (!sources?.videos?.length) {
    throw new Error("Missing source manifest. Run pnpm knicks:scrape first.")
  }
  if (!match.geometry) {
    throw new Error("Match plan has no geometry. Re-run pnpm knicks:match.")
  }
  const geometry = decodeGeometry(match.geometry)

  await ensureDir(CONFIG.paths.clipsDir)
  const sourceById = new Map(sources.videos.map((video) => [video.id, video]))

  // Probe each unique source once up front so pooled workers don't race.
  // Candidates whose source video is gone fall back to a single-frame still.
  const sizeBySourceId = new Map()
  for (const candidate of match.usedCandidates) {
    if (candidate.startT === null || candidate.startT === undefined) continue
    let source = sourceById.get(candidate.videoId)
    if (!source) {
      // A re-scrape can drop a video from sources.json while the plan still
      // references it. The downloaded file is all extraction needs, so fall
      // back to it when it's still on disk.
      const videoPath = path.join(
        CONFIG.paths.videosDir,
        `${candidate.videoId}.mp4`
      )
      if (!(await exists(videoPath))) continue
      source = {
        id: candidate.videoId,
        path: videoPath,
        title: candidate.title ?? candidate.videoId,
      }
      sourceById.set(source.id, source)
    }
    if (!sizeBySourceId.has(source.id)) {
      sizeBySourceId.set(source.id, await probeVideoSize(source.path))
    }
  }

  console.log(
    `Extracting ${match.usedCandidates.length} clips with concurrency ${CLIP_CONCURRENCY}`
  )
  const clips = new Array(match.usedCandidates.length)
  let done = 0
  let stills = 0
  await runPool(match.usedCandidates, CLIP_CONCURRENCY, async (candidate, i) => {
    const source = sourceById.get(candidate.videoId)
    const sourceSize = source ? sizeBySourceId.get(source.id) : null
    if (
      candidate.startT === null ||
      candidate.startT === undefined ||
      !sourceSize
    ) {
      clips[i] = await stillClip(candidate, match, geometry)
      stills++
      done++
      console.log(
        `[${done}/${match.usedCandidates.length}] ${candidate.key} (still frame)`
      )
      return
    }
    clips[i] = await extractClip(candidate, source, match, geometry, sourceSize)
    done++
    console.log(
      `[${done}/${match.usedCandidates.length}] ${candidate.key} at ${clips[i].width}x${clips[i].height} from ${source.title}`
    )
  })
  if (stills) {
    console.log(`${stills} candidate(s) used still frames (source video gone).`)
  }

  await writeJson(CONFIG.paths.clipsPath, {
    profile: CONFIG.profileName,
    generatedAt: new Date().toISOString(),
    clips,
  })

  console.log(`Extracted ${clips.length} clip frame sequences.`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
