import path from "node:path"

import { CONFIG } from "./config.mjs"
import { ensureDir, readJson, writeJson } from "./lib/common.mjs"
import { segmentVideo } from "./lib/segment.mjs"

function parseArgs() {
  const args = new Set(process.argv.slice(2))
  return {
    dryRun: args.has("--dry-run"),
  }
}

async function segmentSources({ dryRun = false } = {}) {
  const sources = await readJson(CONFIG.paths.sourcesPath)
  if (!sources?.videos?.length) {
    throw new Error("Missing source videos. Run pnpm knicks:scrape first.")
  }

  await ensureDir(CONFIG.paths.segmentsDir)
  const videos = []

  for (const video of sources.videos) {
    console.log(`Segmenting ${video.tier}: ${video.title}`)
    const segments = await segmentVideo(video)
    const nextVideo = { ...video, segments }
    videos.push(nextVideo)
    console.log(`  ${segments.length} segments`)

    if (!dryRun) {
      await writeJson(path.join(CONFIG.paths.segmentsDir, `${video.id}.json`), {
        video: {
          id: video.id,
          title: video.title,
          tier: video.tier,
          duration: video.duration ?? video.durationSec,
        },
        generatedAt: new Date().toISOString(),
        segments,
      })
    }
  }

  const projectedCandidatePool = videos.reduce((sum, video) => {
    if (video.tier === "hero" && video.chapters?.length) {
      return (
        sum +
        Math.min(CONFIG.mosaic.maxHeroCandidates, video.chapters.length * 2)
      )
    }
    return sum + (video.segments?.length ?? 0)
  }, 0)

  const nextSources = {
    ...sources,
    generatedAt: sources.generatedAt ?? new Date().toISOString(),
    segmentedAt: new Date().toISOString(),
    target: {
      ...(sources.target ?? {}),
      candidatePool: CONFIG.scrape.targetCandidatePool,
      safetyMargin: CONFIG.scrape.poolSafetyMargin,
      projectedCandidatePool,
    },
    videos,
  }

  if (!dryRun) {
    await writeJson(CONFIG.paths.sourcesPath, nextSources)
    console.log(`Updated ${CONFIG.paths.sourcesPath}`)
  } else {
    console.log("Dry run only; no segment files or source manifest writes.")
  }

  console.log(
    `Projected candidate pool after segmentation: ${projectedCandidatePool}`
  )
  return nextSources
}

const { dryRun } = parseArgs()
segmentSources({ dryRun }).catch((error) => {
  console.error(error)
  process.exit(1)
})
