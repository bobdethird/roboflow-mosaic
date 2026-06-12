import fs from "node:fs/promises"
import path from "node:path"

import { CONFIG } from "../config.mjs"
import { captureJson, ensureDir, exists, run } from "./common.mjs"

const WATCH_URL = "https://www.youtube.com/watch?v="

export function videoIdFromUrl(value) {
  const text = String(value ?? "")
  if (/^[\w-]{11}$/.test(text)) return text
  try {
    const url = new URL(text)
    if (url.hostname === "youtu.be")
      return url.pathname.split("/").filter(Boolean)[0]
    return url.searchParams.get("v") ?? undefined
  } catch {
    return undefined
  }
}

export function videoUrlFromId(id) {
  return `${WATCH_URL}${id}`
}

export function ytDlpBaseArgs({ fast = false, download = false } = {}) {
  const scrape = CONFIG.scrape
  const args = ["--no-warnings"]

  if (scrape.cookiesFromBrowser) {
    args.push("--cookies-from-browser", scrape.cookiesFromBrowser)
  }
  if (scrape.extractorArgs) {
    args.push("--extractor-args", scrape.extractorArgs)
  }

  args.push(
    "--socket-timeout",
    fast ? "20" : "40",
    "--extractor-retries",
    String(fast ? 1 : scrape.retries),
    "--retries",
    String(fast ? 1 : scrape.retries),
    "--fragment-retries",
    String(fast ? 1 : scrape.fragmentRetries)
  )

  if (download) {
    args.push(
      "--sleep-requests",
      String(scrape.sleepRequests),
      "--sleep-interval",
      String(scrape.sleepInterval),
      "--max-sleep-interval",
      String(scrape.maxSleepInterval)
    )
  }

  return args
}

function normalizeSearchLocator(value, fallbackLimit) {
  if (/^ytsearch\d*:/i.test(value)) return value
  return `ytsearch${fallbackLimit}:${value}`
}

export function buildGameplaySearches() {
  const { perQueryMax, tier2Searches, gameplayQueryMatrix } = CONFIG.scrape
  const searches = new Set(
    tier2Searches.map((query) => normalizeSearchLocator(query, perQueryMax))
  )

  for (const generic of gameplayQueryMatrix.generic) {
    for (const season of gameplayQueryMatrix.seasons) {
      searches.add(normalizeSearchLocator(`${generic} ${season}`, perQueryMax))
    }
  }

  for (const player of gameplayQueryMatrix.players) {
    for (const action of gameplayQueryMatrix.actions) {
      for (const season of gameplayQueryMatrix.seasons) {
        searches.add(
          normalizeSearchLocator(
            `${player} ${action} Knicks ${season}`,
            perQueryMax
          )
        )
      }
    }
  }

  return [...searches]
}

export function buildFanSearches() {
  const { fanQueriesMax, fanQueryMatrix } = CONFIG.scrape
  // Breadth-first: every base query gets a turn before any seasoned variant,
  // so the fan quota spans distinct scenes (watch party, street night, parade)
  // instead of being exhausted by the first query family.
  const searches = new Set()
  for (const query of fanQueryMatrix.queries) {
    searches.add(normalizeSearchLocator(query, fanQueriesMax))
  }
  for (const query of fanQueryMatrix.queries) {
    for (const season of fanQueryMatrix.seasons) {
      searches.add(normalizeSearchLocator(`${query} ${season}`, fanQueriesMax))
    }
  }
  return [...searches]
}

export async function enumerateFlat(locator, { limit } = {}) {
  const listing = await captureJson(
    "yt-dlp",
    [
      ...ytDlpBaseArgs({ fast: true }),
      "--dump-single-json",
      "--flat-playlist",
      locator,
    ],
    { timeoutMs: 45_000 }
  )
  const entries = Array.isArray(listing.entries) ? listing.entries : []
  return entries.slice(0, limit ?? entries.length).map((entry) => {
    const id = entry.id ?? videoIdFromUrl(entry.url)
    return {
      id,
      url: entry.url?.startsWith("http")
        ? entry.url
        : id
          ? videoUrlFromId(id)
          : entry.url,
      title: entry.title ?? entry.fulltitle ?? id,
      duration: Number(entry.duration ?? 0),
      height: Number(entry.height ?? 0),
      uploader: entry.uploader,
      raw: entry,
    }
  })
}

export async function readVideoMetadata(url) {
  return await captureJson(
    "yt-dlp",
    [
      ...ytDlpBaseArgs({ fast: true }),
      "--dump-single-json",
      "--no-playlist",
      url,
    ],
    { timeoutMs: 60_000 }
  )
}

export async function listDownloadedPath(videoId) {
  const files = await fs.readdir(CONFIG.paths.videosDir).catch(() => [])
  const match = files.find((file) => {
    if (!file.startsWith(`${videoId}.`) || file.endsWith(".part")) return false
    return /\.(mp4|mkv|webm|mov)$/i.test(file)
  })
  return match ? path.join(CONFIG.paths.videosDir, match) : null
}

export async function downloadVideo(url, videoId) {
  const existing = videoId ? await listDownloadedPath(videoId) : null
  if (existing && (await exists(existing))) return existing

  await ensureDir(CONFIG.paths.videosDir)
  const result = await run(
    "yt-dlp",
    [
      ...ytDlpBaseArgs({ download: true }),
      "--no-playlist",
      "-f",
      "bv*[height>=720]+ba/b[height>=720]/best[height>=720]/best",
      "--merge-output-format",
      "mp4",
      "--write-info-json",
      "--download-archive",
      CONFIG.paths.downloadArchivePath,
      "-o",
      path.join(CONFIG.paths.videosDir, "%(id)s.%(ext)s"),
      "--print",
      "after_move:filepath",
      url,
    ],
    { quiet: true }
  )

  const printed = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.endsWith(".part"))
  const filePath =
    printed.find((line) => /\.(mp4|mkv|webm|mov)$/i.test(line)) ??
    (videoId ? await listDownloadedPath(videoId) : null)

  if (!filePath) {
    throw new Error(`download did not produce a complete file for ${url}`)
  }
  return filePath
}

export function estimateWindowsForVideo(video, tier = video.tier) {
  const duration = Number(video.duration ?? video.durationSec ?? 0)
  if (!duration || duration < CONFIG.mosaic.preRollSec + 1) return 0
  if (tier === "hero") {
    const chapterCount = Array.isArray(video.chapters)
      ? video.chapters.length
      : 0
    return Math.min(
      CONFIG.mosaic.maxHeroCandidates,
      chapterCount
        ? chapterCount * 2
        : Math.floor(duration / CONFIG.mosaic.minFillerSepSec)
    )
  }
  const span = Math.max(0, duration - CONFIG.mosaic.preRollSec)
  return Math.min(
    CONFIG.mosaic.maxCandidatesPerFillerVideo,
    Math.floor(span / CONFIG.mosaic.minFillerSepSec) + 1
  )
}

function matchesAny(value, patterns) {
  return patterns.some((pattern) => pattern.test(value))
}

function isLiveCandidate(candidate, title) {
  const raw = candidate.raw && typeof candidate.raw === "object" ? candidate.raw : {}
  const liveStatus = String(
    candidate.live_status ?? raw.live_status ?? ""
  ).toLowerCase()
  return (
    candidate.is_live === true ||
    raw.is_live === true ||
    liveStatus === "is_live" ||
    liveStatus === "is_upcoming" ||
    liveStatus === "post_live" ||
    /\bLIVE\b/.test(title)
  )
}

export function passesSourceFilters(candidate, tier) {
  const title = String(candidate.title ?? "")
  const duration = Number(candidate.duration ?? 0)
  const height = Number(candidate.height ?? 0)
  if (!candidate.id) return { ok: false, reason: "missing id" }
  if (isLiveCandidate(candidate, title)) {
    return { ok: false, reason: "live source" }
  }
  if (
    CONFIG.scrape.dropShorts &&
    /(^|[ /#])shorts?($|[ /#])/i.test(candidate.url ?? "")
  ) {
    return { ok: false, reason: "shorts url" }
  }
  if (matchesAny(title, CONFIG.scrape.titleBlock)) {
    return { ok: false, reason: "blocked title" }
  }
  if (tier !== "hero" && !matchesAny(title, CONFIG.scrape.titleAllow)) {
    return { ok: false, reason: "title did not match allowlist" }
  }
  if (height > 0 && height < CONFIG.scrape.minHeight) {
    return { ok: false, reason: "below height floor" }
  }
  if (duration > 0) {
    const maxDuration =
      tier === "fan"
        ? CONFIG.scrape.fanMaxDurationSec
        : CONFIG.scrape.maxDurationSec
    const minDuration = matchesAny(title, CONFIG.scrape.specialClipTitleAllow)
      ? CONFIG.scrape.minShortClipDurationSec
      : CONFIG.scrape.minDurationSec
    if (duration < minDuration) return { ok: false, reason: "too short" }
    if (duration > maxDuration) return { ok: false, reason: "too long" }
  }
  return { ok: true }
}

export function dedupeByVideoId(candidates) {
  const byId = new Map()
  for (const candidate of candidates) {
    const id = candidate.id ?? videoIdFromUrl(candidate.url)
    if (!id || byId.has(id)) continue
    byId.set(id, { ...candidate, id, url: candidate.url ?? videoUrlFromId(id) })
  }
  return [...byId.values()]
}
