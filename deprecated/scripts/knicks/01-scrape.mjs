import path from "node:path"

import { CONFIG } from "./config.mjs"
import { ensureDir, exists, readJson, writeJson } from "./lib/common.mjs"
import { createSyntheticVideo } from "./lib/media.mjs"
import {
  buildFanSearches,
  buildGameplaySearches,
  dedupeByVideoId,
  downloadVideo,
  enumerateFlat,
  estimateWindowsForVideo,
  passesSourceFilters,
  readVideoMetadata,
  videoIdFromUrl,
} from "./lib/youtube.mjs"

function parseArgs() {
  const args = new Set(process.argv.slice(2))
  return {
    dryRun: args.has("--dry-run"),
    noSynthetic: args.has("--no-synthetic"),
  }
}

function normalizeRecord(meta, tier, filePath, source) {
  const duration = Number(meta.duration ?? source.duration ?? 0)
  return {
    id: meta.id,
    title: meta.title ?? meta.fulltitle ?? meta.id,
    url: meta.webpage_url ?? meta.original_url ?? source.url,
    tier,
    source: source.source ?? "manual",
    path: filePath,
    infoJson: path.join(CONFIG.paths.metadataDir, `${meta.id}.json`),
    duration,
    durationSec: duration,
    height: Number(meta.height ?? source.height ?? 0) || undefined,
    fps: Number(meta.fps ?? 0) || undefined,
    chapters: Array.isArray(meta.chapters) ? meta.chapters : [],
    segments: [],
    projectedWindows: estimateWindowsForVideo(
      {
        ...source,
        duration,
        chapters: meta.chapters,
      },
      tier
    ),
  }
}

async function addSyntheticFallback(records) {
  const heroCount = records.filter((record) => record.tier === "hero").length
  const totalTarget = CONFIG.profileName === "prototype" ? 8 : 0
  let index = 0

  while (heroCount + index < 4 && CONFIG.profileName === "prototype") {
    const id = `synthetic-hero-${index + 1}`
    const filePath = path.join(CONFIG.paths.videosDir, `${id}.mp4`)
    if (!(await exists(filePath))) {
      await createSyntheticVideo(filePath, index, "hero")
    }
    records.push({
      id,
      title: `Synthetic hero ${index + 1}`,
      url: `synthetic:${id}`,
      tier: "hero",
      source: "synthetic-fallback",
      path: filePath,
      infoJson: null,
      duration: 32,
      durationSec: 32,
      height: 720,
      fps: 30,
      chapters: [
        { title: "first play", start_time: 0, end_time: 22 },
        { title: "second play", start_time: 22, end_time: 32 },
      ],
      segments: [],
      projectedWindows: 2,
    })
    index++
  }

  while (records.length < totalTarget) {
    const id = `synthetic-filler-${records.length + 1}`
    const filePath = path.join(CONFIG.paths.videosDir, `${id}.mp4`)
    if (!(await exists(filePath))) {
      await createSyntheticVideo(filePath, records.length, "filler")
    }
    records.push({
      id,
      title: `Synthetic filler ${records.length + 1}`,
      url: `synthetic:${id}`,
      tier: "filler",
      source: "synthetic-fallback",
      path: filePath,
      infoJson: null,
      duration: 32,
      durationSec: 32,
      height: 720,
      fps: 30,
      chapters: [],
      segments: [],
      projectedWindows: estimateWindowsForVideo({ duration: 32 }, "filler"),
    })
  }
}

function inferTier(candidate, fallbackTier) {
  const text = `${candidate.title ?? ""} ${candidate.source ?? ""}`
  if (
    /watch party|fans?|crowd|bar reaction|nyc celebration|storm streets/i.test(
      text
    )
  ) {
    return "fan"
  }
  return fallbackTier
}

function targetPool() {
  return Math.ceil(
    CONFIG.scrape.targetCandidatePool * CONFIG.scrape.poolSafetyMargin
  )
}

function projectedPool(candidates) {
  return candidates.reduce(
    (sum, candidate) =>
      sum + estimateWindowsForVideo(candidate, candidate.tier),
    0
  )
}

function tierCount(candidates, tier) {
  return candidates.filter((candidate) => candidate.tier === tier).length
}

// Per-tier quotas. Without this, a single deep channel listing fills the whole
// non-hero budget with broadcast footage before any fan search runs, which is
// how the library ended up with no dark street/crowd tiles.
function tierIsFull(candidates, tier) {
  if (tier === "fan") {
    return tierCount(candidates, "fan") >= CONFIG.scrape.fanMaxVideos
  }
  if (tier === "filler") {
    return tierCount(candidates, "filler") >= CONFIG.scrape.tier2MaxVideos
  }
  return false
}

function shouldStopDiscovery(candidates) {
  return (
    (tierIsFull(candidates, "fan") && tierIsFull(candidates, "filler")) ||
    projectedPool(candidates) >= targetPool()
  )
}

async function candidateFromDirect(url, tier, source) {
  const meta = await readVideoMetadata(url)
  const candidate = {
    id: meta.id ?? videoIdFromUrl(url),
    url: meta.webpage_url ?? meta.original_url ?? url,
    title: meta.title ?? meta.fulltitle ?? meta.id,
    duration: Number(meta.duration ?? 0),
    height: Number(meta.height ?? 0),
    tier,
    source,
    metadata: meta,
    chapters: Array.isArray(meta.chapters) ? meta.chapters : [],
  }
  candidate.projectedWindows = estimateWindowsForVideo(candidate, tier)
  return candidate
}

async function addDirectSources(candidates, seenIds, urls, tier, source) {
  for (const url of urls) {
    try {
      const candidate = await candidateFromDirect(url, tier, source)
      if (!candidate.id || seenIds.has(candidate.id)) continue
      seenIds.add(candidate.id)
      candidates.push(candidate)
      console.log(
        `Selected ${tier}: ${candidate.title} (${candidate.projectedWindows} projected windows)`
      )
    } catch (error) {
      console.warn(`Skipping ${source} source ${url}: ${error.message}`)
    }
  }
}

function addFlatCandidates(candidates, seenIds, entries, source, fallbackTier) {
  for (const entry of dedupeByVideoId(entries)) {
    const tier = inferTier(entry, fallbackTier)
    const filtered = passesSourceFilters(entry, tier)
    if (!filtered.ok) continue
    if (seenIds.has(entry.id)) continue
    if (tierIsFull(candidates, tier)) continue
    seenIds.add(entry.id)
    candidates.push({
      ...entry,
      tier,
      source,
      projectedWindows: estimateWindowsForVideo(entry, tier),
    })
    if (shouldStopDiscovery(candidates)) return true
  }
  return false
}

async function discoverCandidates() {
  const candidates = []
  const seenIds = new Set()

  await addDirectSources(
    candidates,
    seenIds,
    CONFIG.scrape.heroUrls,
    "hero",
    "hero"
  )
  await addDirectSources(
    candidates,
    seenIds,
    CONFIG.scrape.fanUrls,
    "fan",
    "fan-url"
  )
  await addDirectSources(
    candidates,
    seenIds,
    CONFIG.scrape.tier2Urls,
    "filler",
    "manual"
  )

  // Fan searches run before channels: fan footage (street celebrations, watch
  // parties, night crowds) is the scarce tier and channels can otherwise fill
  // the projected-pool budget on their own.
  const enumerations = [
    ...buildFanSearches().map((locator) => ({
      locator,
      tier: "fan",
      limit: CONFIG.scrape.fanQueriesMax,
    })),
    ...CONFIG.scrape.channels.map((locator) => ({
      locator,
      tier: "filler",
      limit: CONFIG.scrape.perChannelMax,
    })),
    ...buildGameplaySearches().map((locator) => ({
      locator,
      tier: "filler",
      limit: CONFIG.scrape.perQueryMax,
    })),
  ]

  for (const { locator, tier, limit } of enumerations) {
    if (shouldStopDiscovery(candidates)) break
    if (tierIsFull(candidates, tier)) continue
    try {
      const entries = await enumerateFlat(locator, { limit })
      const stopped = addFlatCandidates(
        candidates,
        seenIds,
        entries,
        locator,
        tier
      )
      console.log(
        `Enumerated ${locator}: selected ${candidates.length} videos, projected ${projectedPool(candidates)} windows`
      )
      if (stopped) break
    } catch (error) {
      console.warn(`Skipping source ${locator}: ${error.message}`)
    }
  }

  return candidates
}

function printDiscoveryReport(candidates) {
  const byTier = new Map()
  for (const candidate of candidates) {
    const tierCandidates = byTier.get(candidate.tier) ?? []
    tierCandidates.push(candidate)
    byTier.set(candidate.tier, tierCandidates)
  }
  console.log("")
  console.log("Discovery report")
  console.log(`  profile: ${CONFIG.profileName}`)
  console.log(`  selected videos: ${candidates.length}`)
  console.log(
    `  projected windows: ${projectedPool(candidates)} / ${targetPool()}`
  )
  for (const [tier, tierCandidates] of byTier) {
    console.log(
      `  ${tier}: ${tierCandidates.length} videos, ${projectedPool(tierCandidates)} windows`
    )
  }
  console.log("")
  for (const candidate of candidates.slice(0, 40)) {
    console.log(
      `  [${candidate.tier}] ${candidate.id} ${candidate.projectedWindows}w ${candidate.title}`
    )
  }
  if (candidates.length > 40) {
    console.log(`  ... ${candidates.length - 40} more`)
  }
}

async function downloadSelectedCandidates(candidates) {
  const records = []
  for (const candidate of candidates) {
    try {
      console.log(`${candidate.tier} source: ${candidate.url}`)
      const meta =
        candidate.metadata ?? (await readVideoMetadata(candidate.url))
      const duration = Number(meta.duration ?? candidate.duration ?? 0)
      const filtered = passesSourceFilters(
        { ...candidate, ...meta, duration },
        candidate.tier
      )
      if (!filtered.ok) {
        console.log(`  skipped after metadata: ${filtered.reason}`)
        continue
      }
      const filePath = await downloadVideo(
        candidate.url,
        meta.id ?? candidate.id
      )
      await writeJson(
        path.join(CONFIG.paths.metadataDir, `${meta.id}.json`),
        meta
      )
      records.push(normalizeRecord(meta, candidate.tier, filePath, candidate))
    } catch (error) {
      console.warn(`Could not download ${candidate.url}: ${error.message}`)
    }
  }
  return records
}

async function main() {
  const { dryRun, noSynthetic } = parseArgs()
  await Promise.all([
    ensureDir(CONFIG.paths.videosDir),
    ensureDir(CONFIG.paths.metadataDir),
    ensureDir(CONFIG.paths.segmentsDir),
  ])

  const previous = await readJson(CONFIG.paths.sourcesPath, { videos: [] })
  const candidates = await discoverCandidates()
  printDiscoveryReport(candidates)

  if (dryRun) {
    console.log("Dry run only; no downloads or source manifest writes.")
    return
  }

  const records = await downloadSelectedCandidates(candidates)
  if (!noSynthetic) await addSyntheticFallback(records)

  const merged = records.length ? records : previous.videos
  if (!merged.length) {
    throw new Error("No source videos were downloaded or generated.")
  }

  await writeJson(CONFIG.paths.sourcesPath, {
    profile: CONFIG.profileName,
    generatedAt: new Date().toISOString(),
    target: {
      candidatePool: CONFIG.scrape.targetCandidatePool,
      safetyMargin: CONFIG.scrape.poolSafetyMargin,
      projectedCandidatePool: merged.reduce(
        (sum, record) => sum + Number(record.projectedWindows ?? 0),
        0
      ),
    },
    videos: merged,
  })

  console.log(
    `Wrote ${merged.length} source records to ${CONFIG.paths.sourcesPath}`
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
