// Photo-mosaic pipeline, stage 1 of 2: sample still frames from every scraped
// source video so they can be published as a regular photo-mosaic library.
//
//   pnpm knicks:photo-frames
//
// Frames are written to data/photo-frames/<videoId>/frame_%04d.jpg at
// CONFIG.photo.fps (default 0.33 → about one every 3s). Already-extracted videos are
// skipped so re-runs only pick up newly downloaded sources; set
// KNICKS_PHOTO_FORCE=1 to re-extract everything.

import fs from "node:fs/promises"
import path from "node:path"

import { CONFIG } from "./config.mjs"
import { ensureDir, exists, readJson, run, writeJson } from "./lib/common.mjs"
import { probeDuration, samplingParams } from "./lib/photo-sampling.mjs"

const FORCE = process.env.KNICKS_PHOTO_FORCE === "1"

const manifestPath = () =>
  path.join(CONFIG.paths.photoFramesDir, "manifest.json")

// id → tier from the scrape manifest, so fan-tier videos can be over-sampled.
async function loadTiers() {
  const sources = await readJson(CONFIG.paths.sourcesPath, { videos: [] })
  return new Map(sources.videos.map((video) => [video.id, video.tier]))
}

function videoIdFromFile(file) {
  return file.replace(/\.mp4$/i, "")
}

async function listSourceVideos() {
  const dir = CONFIG.paths.videosDir
  if (!(await exists(dir))) return []
  const entries = await fs.readdir(dir)
  return entries
    .filter((name) => name.toLowerCase().endsWith(".mp4"))
    .map((name) => ({ id: videoIdFromFile(name), path: path.join(dir, name) }))
    .filter(
      (video) =>
        !CONFIG.photo.skipPrefixes.some((prefix) => video.id.startsWith(prefix))
    )
    .sort((a, b) => a.id.localeCompare(b.id))
}

async function dirHasFrames(dir) {
  if (!(await exists(dir))) return false
  const entries = await fs.readdir(dir)
  return entries.some((name) => name.toLowerCase().endsWith(".jpg"))
}

async function extractFrames(video, tier, manifest) {
  const outDir = path.join(CONFIG.paths.photoFramesDir, video.id)
  const duration = await probeDuration(video.path)
  const { startAt, window, fps } = samplingParams(duration, tier)

  if (!FORCE && (await dirHasFrames(outDir))) {
    console.log(`  skip ${video.id} (already extracted)`)
    manifest[video.id] = {
      fps,
      startAt,
      frames: (await fs.readdir(outDir)).filter((name) =>
        name.toLowerCase().endsWith(".jpg")
      ).length,
    }
    return 0
  }
  await fs.rm(outDir, { recursive: true, force: true })
  await ensureDir(outDir)

  const { longEdge } = CONFIG.photo
  const filter = [
    `fps=${fps.toFixed(6)}`,
    // Cap the long edge at CONFIG.photo.longEdge without ever upscaling a
    // smaller source (min() keeps e.g. 720p videos at their native size).
    `scale='min(iw,${longEdge})':'min(ih,${longEdge})':force_original_aspect_ratio=decrease:flags=lanczos`,
  ].join(",")

  // `-ss` before `-i` (input seek) resets timestamps to 0, so `-t` is the length
  // of the sampled window measured from `startAt`.
  const args = ["-hide_banner", "-loglevel", "error", "-y"]
  if (startAt > 0) args.push("-ss", startAt.toFixed(3))
  args.push("-i", video.path)
  if (window) args.push("-t", window.toFixed(3))
  args.push(
    "-vf",
    filter,
    "-an",
    "-q:v",
    "3",
    path.join(outDir, "frame_%04d.jpg")
  )

  await run("ffmpeg", args, { quiet: true })

  const frames = (await fs.readdir(outDir)).filter((name) =>
    name.toLowerCase().endsWith(".jpg")
  ).length
  manifest[video.id] = { fps, startAt, frames }
  const windowNote = window
    ? ` (${startAt.toFixed(0)}–${(startAt + window).toFixed(0)}s of ${duration.toFixed(0)}s)`
    : ""
  const tierNote = boost !== 1 ? ` [${tier} ×${boost}]` : ""
  console.log(
    `  ${video.id}: ${frames} frames @ ${fps.toFixed(3)}fps${windowNote}${tierNote}`
  )
  return frames
}

async function main() {
  const videos = await listSourceVideos()
  if (videos.length === 0) {
    console.log(
      `No source videos in ${CONFIG.paths.videosDir}. Run pnpm knicks:scrape first.`
    )
    return
  }

  console.log(
    `Sampling ${videos.length} videos → ${CONFIG.paths.photoFramesDir} ` +
      `(fps=${CONFIG.photo.fps}, maxPerVideo=${CONFIG.photo.maxPerVideo || "∞"}, ` +
      `trim head/tail=${CONFIG.photo.headTrimSec}s/${CONFIG.photo.tailTrimSec}s)`
  )

  const tiers = await loadTiers()
  // Per-video sampling parameters, so downstream stages (03-match) can map a
  // frame file back to its source-video timestamp. Existing entries for videos
  // no longer on disk are kept so already-extracted frame dirs stay mapped.
  const manifest = (await readJson(manifestPath(), { videos: {} })).videos ?? {}
  let total = 0
  for (const video of videos) {
    total += await extractFrames(video, tiers.get(video.id), manifest)
  }
  await writeJson(manifestPath(), {
    generatedAt: new Date().toISOString(),
    videos: manifest,
  })
  console.log(`Done. ~${total} frames available. Next: pnpm knicks:photo-seed`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
