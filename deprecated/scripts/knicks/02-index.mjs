import path from "node:path"

import { CONFIG } from "./config.mjs"
import {
  candidateKey,
  clamp,
  ensureDir,
  formatSeconds,
  readJson,
  writeJson,
} from "./lib/common.mjs"
import { extractFrame } from "./lib/media.mjs"
import { encodeSignature, signatureFromImage } from "./lib/signature.mjs"

function uniqueSorted(values) {
  return [...new Set(values.map((value) => Number(value.toFixed(3))))].sort(
    (a, b) => a - b
  )
}

function heroTimes(video) {
  const { preRollSec, chapterEndWindowSec, maxHeroCandidates } = CONFIG.mosaic
  const chapters = video.chapters?.length ? video.chapters : []
  if (!chapters.length && video.segments?.length) {
    return segmentTimes(video)
  }
  if (!chapters.length) {
    return fillerTimes(video)
  }
  const offsets = [0.15, 0.35, 0.75, 1.25, 2, 3, 4, chapterEndWindowSec]
  const times = []

  for (const chapter of chapters) {
    const end = Number(chapter.end_time ?? chapter.end ?? 0)
    if (!end) continue
    for (const offset of offsets) {
      const t = end - offset
      if (t >= preRollSec && t <= video.duration - 0.15) {
        times.push(t)
      }
    }
  }

  return uniqueSorted(times).slice(-maxHeroCandidates)
}

function segmentTimes(video) {
  const { preRollSec, maxCandidatesPerFillerVideo } = CONFIG.mosaic
  return uniqueSorted(
    (video.segments ?? [])
      .map((segment) => Number(segment.keyT))
      .filter(
        (t) =>
          Number.isFinite(t) &&
          t >= preRollSec &&
          t <= Number(video.duration ?? video.durationSec ?? 0) - 0.15
      )
  ).slice(0, maxCandidatesPerFillerVideo)
}

function segmentForTime(video, t) {
  return (video.segments ?? []).find(
    (segment) => Math.abs(Number(segment.keyT) - t) < 0.001
  )
}

function fillerTimes(video) {
  if (video.segments?.length) {
    const times = segmentTimes(video)
    if (times.length) return times
  }

  const { preRollSec, minFillerSepSec, maxCandidatesPerFillerVideo } =
    CONFIG.mosaic
  const duration = Number(video.duration ?? 0)
  if (!duration || duration < preRollSec + 2) return []

  const first = preRollSec
  const last = Math.max(first, duration - 1)
  const span = last - first
  const count = Math.max(
    1,
    Math.min(
      maxCandidatesPerFillerVideo,
      Math.floor(span / minFillerSepSec) + 1
    )
  )
  const times = []
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? first : first + (span * i) / Math.max(1, count - 1)
    times.push(clamp(t, first, last))
  }
  return uniqueSorted(times)
}

async function indexCandidate(video, t) {
  const segment = segmentForTime(video, t)
  const key = candidateKey(video.id, t)
  const framePath = path.join(CONFIG.paths.framesDir, video.id, `${key}.jpg`)
  await extractFrame(video.path, t, framePath)
  const sig = await signatureFromImage(framePath)
  return {
    key,
    videoId: video.id,
    tier: video.tier,
    title: video.title,
    url: video.url,
    framePath,
    t,
    segmentStart: segment?.start,
    segmentEnd: segment?.end,
    segmentSource: segment?.source,
    loudnessDb: segment?.loudnessDb,
    signature: encodeSignature(sig),
  }
}

async function main() {
  const sources = await readJson(CONFIG.paths.sourcesPath)
  if (!sources?.videos?.length) {
    throw new Error("Missing source videos. Run pnpm knicks:scrape first.")
  }

  await Promise.all([
    ensureDir(CONFIG.paths.framesDir),
    ensureDir(CONFIG.paths.indexesDir),
  ])

  const allCandidates = []
  for (const video of sources.videos) {
    const times = video.tier === "hero" ? heroTimes(video) : fillerTimes(video)
    const candidates = []

    console.log(
      `${video.tier}: ${video.title} (${times.length} candidate frames)`
    )
    for (const t of times) {
      try {
        candidates.push(await indexCandidate(video, t))
        console.log(`  indexed ${formatSeconds(t)}s`)
      } catch (error) {
        console.warn(`  skipped ${formatSeconds(t)}s: ${error.message}`)
      }
    }

    await writeJson(path.join(CONFIG.paths.indexesDir, `${video.id}.json`), {
      video,
      candidates,
    })
    allCandidates.push(...candidates)
  }

  if (!allCandidates.length) {
    throw new Error("No candidate frames were indexed.")
  }

  await writeJson(CONFIG.paths.indexPath, {
    profile: CONFIG.profileName,
    generatedAt: new Date().toISOString(),
    candidates: allCandidates,
  })

  console.log(
    `Wrote ${allCandidates.length} candidates to ${CONFIG.paths.indexPath}`
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
