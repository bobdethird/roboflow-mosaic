import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import sharp from "sharp"

import { ensureDir, readJson, shortHash, writeJson } from "./lib/common.mjs"
import {
  COARSE_LEN,
  downsampleSig,
  lumStd,
  SIG_BYTES,
  SIGNATURE_CHANNELS,
  SIGNATURE_GRID,
} from "./lib/signature.mjs"

const pipelineRoot = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(pipelineRoot, "..")

const TEAM_ID = "1610612752"
const API_BASE = `https://content-api-prod.nba.com/public/1/leagues/nba/teams/${TEAM_ID}/content`
const DEFAULT_BUCKET = "knicks-mosaic"
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"

const MANIFEST_PATH = "manifest.json"
const SIGNATURES_PATH = "signatures.bin"
const COARSE_SIGNATURES_PATH = "signatures-coarse.bin"
const COARSE_SIG_BYTES = COARSE_LEN * 2
const thumbPath = (id) => `thumbs/${id}.jpg`
const originalPath = (id) => `originals/${id}`

function parseArgs(argv) {
  const args = {
    bucket: process.env.KNICKS_PHOTO_BUCKET || DEFAULT_BUCKET,
    count: 50,
    concurrency: 12,
    delayMs: envNumber("KNICKS_PHOTO_API_PAGE_DELAY_MS", 5000),
    dryRun: false,
    flatnessMin: envNumber("KNICKS_PHOTO_FLATNESS_MIN", 10),
    force: process.env.KNICKS_PHOTO_REUPLOAD === "1",
    apiAttempts: envNumber("KNICKS_PHOTO_API_ATTEMPTS", 8),
    apiRetryDelayMs: envNumber("KNICKS_PHOTO_API_RETRY_DELAY_MS", 1000),
    apiTimeoutMs: envNumber("KNICKS_PHOTO_API_TIMEOUT_MS", 15000),
    localManifest: path.join(pipelineRoot, "data", "knicks-photo-library-manifest.json"),
    localSignatures: path.join(pipelineRoot, "data", "knicks-photo-library-signatures.bin"),
    localCoarseSignatures: path.join(
      pipelineRoot,
      "data",
      "knicks-photo-library-signatures-coarse.bin"
    ),
    offset: 0,
    originalQuality: envNumber("KNICKS_PHOTO_ORIGINAL_JPEG_QUALITY", 90),
    prefix: process.env.KNICKS_PHOTO_LIBRARY_PREFIX || "",
    preferLocalSources: process.env.KNICKS_PHOTO_PREFER_LOCAL_SOURCES !== "0",
    sourceManifest: process.env.KNICKS_PHOTO_SOURCE_MANIFEST
      ? path.resolve(process.env.KNICKS_PHOTO_SOURCE_MANIFEST)
      : path.join(repoRoot, "photos", "manifest.json"),
    sourceAttempts: envNumber("KNICKS_PHOTO_SOURCE_ATTEMPTS", 3),
    sourceTimeoutMs: envNumber("KNICKS_PHOTO_SOURCE_TIMEOUT_MS", 30000),
    thumbMax: envNumber("KNICKS_PHOTO_THUMB_MAX", 200),
    thumbQuality: envNumber("KNICKS_PHOTO_THUMB_QUALITY", 82),
    uploadAttempts: envNumber("KNICKS_PHOTO_UPLOAD_ATTEMPTS", 3),
    uploadTimeoutMs: envNumber("KNICKS_PHOTO_UPLOAD_TIMEOUT_MS", 60000),
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--api-attempts") args.apiAttempts = Number(argv[++i])
    else if (arg === "--api-retry-delay-ms") args.apiRetryDelayMs = Number(argv[++i])
    else if (arg === "--api-timeout-ms") args.apiTimeoutMs = Number(argv[++i])
    else if (arg === "--bucket") args.bucket = argv[++i]
    else if (arg === "--count") args.count = Number(argv[++i])
    else if (arg === "--concurrency") args.concurrency = Number(argv[++i])
    else if (arg === "--delay-ms") args.delayMs = Number(argv[++i])
    else if (arg === "--dry-run") args.dryRun = true
    else if (arg === "--flatness-min") args.flatnessMin = Number(argv[++i])
    else if (arg === "--force") args.force = true
    else if (arg === "--coarse-only") args.coarseOnly = true
    else if (arg === "--limit-galleries") args.limitGalleries = Number(argv[++i])
    else if (arg === "--limit-photos") args.limitPhotos = Number(argv[++i])
    else if (arg === "--local-manifest") args.localManifest = path.resolve(argv[++i])
    else if (arg === "--local-signatures") args.localSignatures = path.resolve(argv[++i])
    else if (arg === "--local-coarse-signatures")
      args.localCoarseSignatures = path.resolve(argv[++i])
    else if (arg === "--offset") args.offset = Number(argv[++i])
    else if (arg === "--original-quality") args.originalQuality = Number(argv[++i])
    else if (arg === "--prefix") args.prefix = argv[++i]
    else if (arg === "--source-manifest") args.sourceManifest = path.resolve(argv[++i])
    else if (arg === "--no-local-sources") args.preferLocalSources = false
    else if (arg === "--source-attempts") args.sourceAttempts = Number(argv[++i])
    else if (arg === "--source-timeout-ms") args.sourceTimeoutMs = Number(argv[++i])
    else if (arg === "--thumb-max") args.thumbMax = Number(argv[++i])
    else if (arg === "--thumb-quality") args.thumbQuality = Number(argv[++i])
    else if (arg === "--upload-attempts") args.uploadAttempts = Number(argv[++i])
    else if (arg === "--upload-timeout-ms") args.uploadTimeoutMs = Number(argv[++i])
    else if (arg === "--help") args.help = true
    else throw new Error(`Unknown argument: ${arg}`)
  }

  args.prefix = cleanPrefix(args.prefix)
  return args
}

function usageText() {
  return `Usage: node 07-seed-knicks-photo-library-supabase.mjs [options]

Publishes the NBA Knicks photo galleries in the same Supabase Storage layout used
by the personal website photo mosaic:

  manifest.json
  signatures.bin
  signatures-coarse.bin
  thumbs/<id>.jpg
  originals/<id>

Required env:
  NEXT_PUBLIC_SUPABASE_URL
  SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY

Options:
  --bucket <name>          Storage bucket (default: knicks-mosaic)
  --prefix <path>          Optional object prefix for smoke tests
  --count <n>              API page size (default: 50)
  --offset <n>             Start gallery offset (default: 0)
  --limit-galleries <n>    Stop after N galleries
  --limit-photos <n>       Stop after N source photos
  --concurrency <n>        Parallel indexing/uploads (default: 12)
  --delay-ms <n>           Delay between API pages (default: 5000)
  --local-coarse-signatures <path> Local coarse signature output
  --flatness-min <n>       Drop near-flat signatures below this stddev (default: 10)
  --original-quality <n>   JPEG quality for stored originals (default: 90)
  --source-manifest <path> Local photo manifest from 05-download (default: ../photos/manifest.json)
  --no-local-sources       Always download source images from the NBA CDN
  --api-attempts <n>       Attempts per gallery API page (default: 8)
  --api-retry-delay-ms <n> Base gallery API retry delay (default: 1000)
  --api-timeout-ms <n>     Timeout for gallery API requests (default: 15000)
  --source-attempts <n>    Attempts per source image download (default: 3)
  --source-timeout-ms <n>  Timeout per source image download attempt (default: 30000)
  --thumb-max <n>          Thumbnail long edge (default: 200)
  --thumb-quality <n>      JPEG thumbnail quality (default: 82)
  --upload-attempts <n>    Attempts per Supabase upload (default: 3)
  --upload-timeout-ms <n>  Timeout per Supabase upload attempt (default: 60000)
  --force                  Re-upload thumbs/originals even if manifest has the id
  --coarse-only            Build/upload signatures-coarse.bin from local signatures only
  --dry-run                Build local manifest/signatures without uploading
  --help                   Show this help
`
}

function envNumber(name, fallback) {
  const value = process.env[name]
  if (value === undefined || value === "") return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function validateArgs(args) {
  for (const [name, value] of [
    ["api-attempts", args.apiAttempts],
    ["api-retry-delay-ms", args.apiRetryDelayMs],
    ["api-timeout-ms", args.apiTimeoutMs],
    ["count", args.count],
    ["concurrency", args.concurrency],
    ["delay-ms", args.delayMs],
    ["flatness-min", args.flatnessMin],
    ["offset", args.offset],
    ["original-quality", args.originalQuality],
    ["source-attempts", args.sourceAttempts],
    ["source-timeout-ms", args.sourceTimeoutMs],
    ["thumb-max", args.thumbMax],
    ["thumb-quality", args.thumbQuality],
    ["upload-attempts", args.uploadAttempts],
    ["upload-timeout-ms", args.uploadTimeoutMs],
  ]) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Invalid --${name}: ${value}`)
    }
  }
  if (args.count < 1 || args.count > 100) throw new Error("--count must be between 1 and 100")
  if (args.concurrency < 1) throw new Error("--concurrency must be at least 1")
  if (args.sourceAttempts < 1) throw new Error("--source-attempts must be at least 1")
  if (args.uploadAttempts < 1) throw new Error("--upload-attempts must be at least 1")
  if (args.apiAttempts < 1) throw new Error("--api-attempts must be at least 1")
  if (args.apiRetryDelayMs < 1) throw new Error("--api-retry-delay-ms must be at least 1")
  if (args.apiTimeoutMs < 1) throw new Error("--api-timeout-ms must be at least 1")
  if (args.sourceTimeoutMs < 1) throw new Error("--source-timeout-ms must be at least 1")
  if (args.uploadTimeoutMs < 1) throw new Error("--upload-timeout-ms must be at least 1")
  if (args.originalQuality < 1 || args.originalQuality > 100) {
    throw new Error("--original-quality must be between 1 and 100")
  }
  if (args.thumbQuality < 1 || args.thumbQuality > 100) {
    throw new Error("--thumb-quality must be between 1 and 100")
  }
  if (!args.bucket) throw new Error("--bucket is required")
}

async function loadEnvLocal() {
  const envPath = path.join(repoRoot, ".env.local")
  let text
  try {
    text = await fs.readFile(envPath, "utf8")
  } catch (error) {
    if (error.code === "ENOENT") return
    throw error
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#") || !line.includes("=")) continue
    const index = line.indexOf("=")
    const key = line.slice(0, index).trim()
    let value = line.slice(index + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (!process.env[key]) process.env[key] = value
  }
}

function supabaseConfig() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "")
  const key =
    process.env.SUPABASE_SECRET_KEY?.trim() ||
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()

  if (!url) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL in environment or .env.local")
  if (!key) {
    throw new Error(
      "Missing SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY in environment or .env.local"
    )
  }
  return { url, key }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function sanitizeSegment(value, fallback) {
  const cleaned = String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 140)
  return cleaned || fallback
}

function cleanPrefix(prefix) {
  return String(prefix || "")
    .split("/")
    .map((segment) => sanitizeSegment(segment, ""))
    .filter(Boolean)
    .join("/")
}

function storagePath(prefix, objectPath) {
  return [prefix, objectPath].filter(Boolean).join("/")
}

function encodeStoragePath(objectPath) {
  return objectPath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")
}

function gallerySlug(gallery) {
  return sanitizeSegment(gallery.slug || gallery.name || gallery.title, `gallery-${gallery.id}`)
}

function collectImages(blocks) {
  const images = []

  function visit(value) {
    if (!value) return
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (typeof value !== "object") return

    if (value.type === "image" && value.attributes?.src) {
      images.push({
        idHint: value.attributes.id || shortHash(value.attributes.src),
        src: value.attributes.src,
        alt: value.attributes.alt || "",
        caption: value.attributes.caption || "",
        credit: value.attributes.credit || "",
        copyright: value.attributes.copyright || "",
        width: value.attributes.size?.width ?? null,
        height: value.attributes.size?.height ?? null,
      })
    }

    for (const key of ["children", "content", "innerBlocks", "items"]) {
      if (value[key]) visit(value[key])
    }
  }

  visit(blocks)

  const seen = new Set()
  return images.filter((image) => {
    if (seen.has(image.src)) return false
    seen.add(image.src)
    return true
  })
}

function localPhotoPath(outputPath) {
  return path.resolve(repoRoot, outputPath)
}

async function loadLocalSourceManifest(manifestPath) {
  const manifest = await readJson(manifestPath, null)
  if (!manifest?.galleries) return new Map()

  const sources = new Map()
  for (const gallery of manifest.galleries) {
    for (const image of gallery.images ?? []) {
      if (!image?.src || !image.outputPath) continue
      if (!["downloaded", "skipped"].includes(image.status)) continue
      sources.set(image.src, {
        outputPath: localPhotoPath(image.outputPath),
        status: image.status,
      })
    }
  }
  return sources
}

function hashId(buf) {
  return createHash("sha256").update(buf).digest().subarray(0, 12).toString("hex")
}

async function signatureFromBuffer(buf) {
  const { data, info } = await sharp(buf)
    .rotate()
    .resize(SIGNATURE_GRID, SIGNATURE_GRID, { fit: "cover" })
    .removeAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true })

  const sig = new Uint8Array(SIG_BYTES)
  for (let i = 0; i < SIGNATURE_GRID * SIGNATURE_GRID; i++) {
    const src = i * info.channels
    const dst = i * SIGNATURE_CHANNELS
    if (info.channels === 1) {
      sig[dst] = data[src]
      sig[dst + 1] = data[src]
      sig[dst + 2] = data[src]
    } else {
      sig[dst] = data[src]
      sig[dst + 1] = data[src + 1]
      sig[dst + 2] = data[src + 2]
    }
  }
  return sig
}

async function renderThumb(buf, args) {
  const { data, info } = await sharp(buf)
    .rotate()
    .resize(args.thumbMax, args.thumbMax, {
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: args.thumbQuality })
    .toBuffer({ resolveWithObject: true })
  return { blob: data, w: info.width, h: info.height }
}

async function renderOriginal(buf, args) {
  return await sharp(buf)
    .rotate()
    .jpeg({ quality: args.originalQuality, mozjpeg: args.originalQuality < 100 })
    .toBuffer()
}

const RETRYABLE_HTTP_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504])

class HttpResponseError extends Error {
  constructor(response, body) {
    super(`${response.status} ${response.statusText}: ${body.slice(0, 180)}`)
    this.name = "HttpResponseError"
    this.status = response.status
    this.body = body
  }
}

function normalizeRetryOptions(retryOptions) {
  const options =
    typeof retryOptions === "number" ? { attempts: retryOptions } : retryOptions ?? {}
  return {
    attempts: options.attempts ?? 5,
    baseDelayMs: options.baseDelayMs ?? 750,
    label: options.label,
    onRetry: options.onRetry,
    responseType: options.responseType ?? "response",
    retryStatuses: new Set(options.retryStatuses ?? RETRYABLE_HTTP_STATUSES),
    timeoutMs: options.timeoutMs ?? 30000,
  }
}

function retryDelayMs({ attempt, baseDelayMs }) {
  return baseDelayMs * 2 ** (attempt - 1)
}

function isRetryableFetchError(error, retryStatuses) {
  if (error?.status) return retryStatuses.has(error.status)
  return (
    error?.name === "AbortError" ||
    error?.code === "ETIMEDOUT" ||
    error?.code === "ECONNRESET" ||
    error?.code === "EPIPE" ||
    error?.code === "UND_ERR_HEADERS_TIMEOUT" ||
    error?.code === "UND_ERR_BODY_TIMEOUT" ||
    error?.cause?.code === "ETIMEDOUT" ||
    error?.cause?.code === "ECONNRESET" ||
    error?.cause?.code === "UND_ERR_HEADERS_TIMEOUT" ||
    error?.cause?.code === "UND_ERR_BODY_TIMEOUT"
  )
}

async function readResponse(response, responseType) {
  if (responseType === "buffer") {
    return {
      buffer: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get("content-type") || "",
    }
  }
  if (responseType === "json") return await response.json()
  if (responseType === "text") return await response.text()
  return response
}

async function fetchWithRetry(url, options = {}, retryOptions = {}) {
  const config = normalizeRetryOptions(retryOptions)
  let lastError
  for (let attempt = 1; attempt <= config.attempts; attempt++) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs)
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          "user-agent": USER_AGENT,
          accept: "*/*",
          ...options.headers,
        },
      })
      if (response.ok) return await readResponse(response, config.responseType)

      const body = await response.text().catch(() => "")
      throw new HttpResponseError(response, body)
    } catch (error) {
      lastError =
        error?.name === "AbortError"
          ? new Error(
              `${config.label ?? url} timed out after ${config.timeoutMs}ms`
            )
          : error
      if (
        attempt >= config.attempts ||
        !isRetryableFetchError(lastError, config.retryStatuses)
      ) {
        throw lastError
      }
    } finally {
      clearTimeout(timeout)
    }

    const delayMs = retryDelayMs({ attempt, baseDelayMs: config.baseDelayMs })
    config.onRetry?.({
      attempt,
      attempts: config.attempts,
      delayMs,
      error: lastError,
      label: config.label ?? String(url),
    })
    await sleep(delayMs)
  }
  throw lastError
}

function assertImagePayload({ buffer, contentType, src }) {
  const normalizedType = contentType.split(";")[0].trim().toLowerCase()
  if (
    normalizedType &&
    !normalizedType.startsWith("image/") &&
    normalizedType !== "application/octet-stream"
  ) {
    throw new Error(`Unexpected image response content-type ${contentType} from ${src}`)
  }

  const prefix = buffer.subarray(0, 128).toString("utf8").trimStart().toLowerCase()
  if (prefix.startsWith("<!doctype") || prefix.startsWith("<html")) {
    throw new Error(`Expected image bytes but received HTML from ${src}`)
  }
}

async function readSourceImage({ args, image, localSources }) {
  const localSource = localSources.get(image.src)
  if (localSource) {
    try {
      const buffer = await fs.readFile(localSource.outputPath)
      assertImagePayload({
        buffer,
        contentType: "application/octet-stream",
        src: localSource.outputPath,
      })
      return { buffer, sourceLocation: "local" }
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw new Error(`Failed to read local source ${localSource.outputPath}: ${error.message}`)
      }
    }
  }

  const { buffer, contentType } = await fetchWithRetry(
    image.src,
    {},
    {
      attempts: args.sourceAttempts,
      label: image.src,
      responseType: "buffer",
      timeoutMs: args.sourceTimeoutMs,
    }
  )
  assertImagePayload({ buffer, contentType, src: image.src })
  return { buffer, sourceLocation: "remote" }
}

function retryErrorSummary(error) {
  if (error?.status) return error.message.split(":")[0].trim()
  return error?.message || String(error)
}

async function fetchGalleryPage({ args, collectionProgress, count, offset }) {
  const url = new URL(API_BASE)
  url.searchParams.set("types", "gallery")
  url.searchParams.set("count", String(count))
  url.searchParams.set("offset", String(offset))
  url.searchParams.set("platform", "web")

  return await fetchWithRetry(
    url,
    {
      headers: { accept: "application/json" },
    },
    {
      attempts: args.apiAttempts,
      baseDelayMs: args.apiRetryDelayMs,
      label: `gallery API offset ${offset}`,
      onRetry: ({ attempt, attempts, delayMs, error, label }) => {
        collectionProgress?.warn(
          `${label} failed (${retryErrorSummary(error)}), retry ${attempt + 1}/${attempts} in ${delayMs}ms`
        )
      },
      responseType: "json",
      timeoutMs: args.apiTimeoutMs,
    }
  )
}

async function fetchGalleryPageAdaptive({ args, collectionProgress, count, offset }) {
  try {
    return await fetchGalleryPage({ args, collectionProgress, count, offset })
  } catch (error) {
    if (count <= 1) throw error

    const firstCount = Math.ceil(count / 2)
    const secondCount = count - firstCount
    collectionProgress?.warn(
      `gallery API offset ${offset} count ${count} failed after retries (${retryErrorSummary(
        error
      )}); splitting into ${firstCount}${secondCount ? ` + ${secondCount}` : ""}`
    )

    const first = await fetchGalleryPageAdaptive({
      args,
      collectionProgress,
      count: firstCount,
      offset,
    })
    if (secondCount <= 0) return first

    if (args.delayMs > 0) await sleep(args.delayMs)
    const second = await fetchGalleryPageAdaptive({
      args,
      collectionProgress,
      count: secondCount,
      offset: offset + firstCount,
    })

    const firstResults = first.results ?? {}
    const secondResults = second.results ?? {}
    return {
      ...first,
      results: {
        ...firstResults,
        items: [...(firstResults.items ?? []), ...(secondResults.items ?? [])],
        total: firstResults.total ?? secondResults.total,
      },
    }
  }
}

async function mapLimit(items, limit, worker) {
  let next = 0
  const out = new Array(items.length)
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      out[index] = await worker(items[index], index)
    }
  })
  await Promise.all(workers)
  return out
}

function createCollectionReporter() {
  const state = {
    fetchedPages: 0,
    galleries: 0,
    offset: 0,
    sourcePhotos: 0,
    total: null,
  }

  function render(message) {
    const total = state.total ?? "?"
    const line =
      message ??
      `collecting galleries offset ${state.offset} | pages ${state.fetchedPages} ` +
        `galleries ${state.galleries}/${total} source photos ${state.sourcePhotos}`
    console.log(line)
  }

  return {
    start(offset) {
      state.offset = offset
      render(`collecting galleries from NBA API at offset ${offset}...`)
    },
    page({ offset, total, galleryCount, sourcePhotoCount }) {
      state.fetchedPages++
      state.offset = offset
      state.total = total
      state.galleries += galleryCount
      state.sourcePhotos += sourcePhotoCount
      render()
    },
    warn(message) {
      console.warn(message)
    },
    done(taskCount) {
      console.log(
        `Collected ${state.galleries} galleries and ${taskCount} source photo task(s) from NBA API.`
      )
    },
  }
}

function createProgressReporter() {
  const state = {
    accepted: 0,
    done: 0,
    failed: 0,
    flat: 0,
    inFlight: 0,
    queued: 0,
    reused: 0,
    skippedObjects: 0,
    uploadedObjects: 0,
  }
  let lastLength = 0

  function clearLine() {
    if (!process.stdout.isTTY || lastLength === 0) return
    process.stdout.write(`\r${" ".repeat(lastLength)}\r`)
    lastLength = 0
  }

  function render() {
    if (!process.stdout.isTTY) return
    const width = 24
    const ratio = state.queued ? state.done / state.queued : 0
    const filled = Math.min(width, Math.floor(ratio * width))
    const bar = `${"#".repeat(filled)}${"-".repeat(width - filled)}`
    const pct = state.queued ? `${Math.floor(ratio * 100)}%` : "0%"
    const line =
      `photos [${bar}] ${state.done}/${state.queued} ${pct} ` +
      `in-flight ${state.inFlight} | accepted ${state.accepted} ` +
      `reused ${state.reused} flat ${state.flat} failed ${state.failed} | ` +
      `objects uploaded ${state.uploadedObjects} skipped ${state.skippedObjects}`
    process.stdout.write(`\r${line}`)
    lastLength = line.length
  }

  return {
    addQueued(count) {
      state.queued += count
      render()
    },
    start() {
      state.inFlight++
      render()
    },
    finish(result) {
      state.inFlight = Math.max(0, state.inFlight - 1)
      state.done++
      if (result.status === "flat") state.flat++
      else if (result.status === "failed") state.failed++
      else {
        state.accepted++
        if (result.status === "reused") state.reused++
        state.uploadedObjects += result.uploaded ?? 0
        state.skippedObjects += result.skipped ?? 0
      }
      render()
    },
    log(message) {
      clearLine()
      console.log(message)
      render()
    },
    warn(message) {
      clearLine()
      console.warn(message)
      render()
    },
    done() {
      clearLine()
    },
  }
}

async function downloadExistingManifest({ bucket, config, prefix }) {
  const objectPath = storagePath(prefix, MANIFEST_PATH)
  const url = `${config.url}/storage/v1/object/${encodeURIComponent(bucket)}/${encodeStoragePath(
    objectPath
  )}`
  try {
    const manifest = await fetchWithRetry(
      url,
      {
        headers: {
          apikey: config.key,
          authorization: `Bearer ${config.key}`,
          accept: "application/json",
        },
      },
      {
        attempts: 2,
        label: "existing storage manifest",
        responseType: "json",
        timeoutMs: 15000,
      }
    )
    const photos = Array.isArray(manifest.photos) ? manifest.photos : []
    return {
      byId: new Map(photos.filter((photo) => photo?.id).map((photo) => [photo.id, photo])),
      photos,
    }
  } catch {
    return { byId: new Map(), photos: [] }
  }
}

async function downloadExistingSignatures({ bucket, config, prefix }) {
  const objectPath = storagePath(prefix, SIGNATURES_PATH)
  const url = `${config.url}/storage/v1/object/${encodeURIComponent(bucket)}/${encodeStoragePath(
    objectPath
  )}`
  try {
    const { buffer } = await fetchWithRetry(
      url,
      {
        headers: {
          apikey: config.key,
          authorization: `Bearer ${config.key}`,
          accept: "application/octet-stream",
        },
      },
      {
        attempts: 2,
        label: "existing storage signatures",
        responseType: "buffer",
        timeoutMs: 15000,
      }
    )
    return buffer
  } catch {
    return null
  }
}

function buildReuseBySource({ existingPhotos, existingSignatures }) {
  if (!existingPhotos.length || !existingSignatures) return new Map()
  if (existingSignatures.length !== existingPhotos.length * SIG_BYTES) return new Map()

  const reuseBySrc = new Map()
  for (let index = 0; index < existingPhotos.length; index++) {
    const photo = existingPhotos[index]
    if (!photo?.id || !photo.sourceUrl) continue
    reuseBySrc.set(photo.sourceUrl, {
      id: photo.id,
      photo,
      sig: existingSignatures.subarray(index * SIG_BYTES, (index + 1) * SIG_BYTES),
    })
  }
  return reuseBySrc
}

async function uploadStorageBuffer({
  attempts,
  bucket,
  config,
  contentType,
  data,
  force,
  objectPath,
  timeoutMs,
}) {
  const url = `${config.url}/storage/v1/object/${encodeURIComponent(bucket)}/${encodeStoragePath(
    objectPath
  )}`
  try {
    await fetchWithRetry(
      url,
      {
        body: data,
        headers: {
          apikey: config.key,
          authorization: `Bearer ${config.key}`,
          "cache-control": "31536000",
          "content-type": contentType,
          "x-upsert": force ? "true" : "false",
        },
        method: "POST",
      },
      {
        attempts,
        label: `upload ${objectPath}`,
        timeoutMs,
      }
    )
    return { uploaded: true }
  } catch (error) {
    if (error.status === 400 && /already exists/i.test(error.body || "")) {
      return { uploaded: false, skipped: true }
    }
    throw error
  }
}

async function indexAndUploadImage({
  args,
  config,
  existingPhotos,
  gallery,
  image,
  localSources,
  prefix,
}) {
  const { buffer: source, sourceLocation } = await readSourceImage({
    args,
    image,
    localSources,
  })
  const original = await renderOriginal(source, args)
  const [sig, thumb] = await Promise.all([
    signatureFromBuffer(original),
    renderThumb(original, args),
  ])

  if (lumStd(sig) < args.flatnessMin) {
    return { status: "flat", src: image.src, sourceLocation }
  }

  const id = hashId(original)
  const fullPath = originalPath(id)
  const storedThumbPath = storagePath(prefix, thumbPath(id))
  const storedOriginalPath = storagePath(prefix, fullPath)

  let uploaded = 0
  let skipped = 0
  const existing = existingPhotos.get(id)

  if (!args.dryRun && (args.force || !existing)) {
    const [thumbResult, originalResult] = await Promise.all([
      uploadStorageBuffer({
        attempts: args.uploadAttempts,
        bucket: args.bucket,
        config,
        contentType: "image/jpeg",
        data: thumb.blob,
        force: args.force,
        objectPath: storedThumbPath,
        timeoutMs: args.uploadTimeoutMs,
      }),
      uploadStorageBuffer({
        attempts: args.uploadAttempts,
        bucket: args.bucket,
        config,
        contentType: "image/jpeg",
        data: original,
        force: args.force,
        objectPath: storedOriginalPath,
        timeoutMs: args.uploadTimeoutMs,
      }),
    ])
    uploaded += Number(Boolean(thumbResult.uploaded)) + Number(Boolean(originalResult.uploaded))
    skipped += Number(Boolean(thumbResult.skipped)) + Number(Boolean(originalResult.skipped))
  } else if (existing) {
    skipped += 2
  }

  return {
    id,
    sig,
    status: args.dryRun ? "indexed" : "uploaded",
    sourceLocation,
    uploaded,
    skipped,
    photo: {
      id,
      w: thumb.w,
      h: thumb.h,
      fullPath: storagePath(prefix, fullPath),
      gallery: gallerySlug(gallery),
      galleryTitle: gallery.title,
      sourceUrl: image.src,
      sourceWidth: image.width,
      sourceHeight: image.height,
    },
  }
}

async function processImageTask({
  args,
  config,
  existingPhotos,
  localSources,
  prefix,
  reuseBySrc,
  task,
}) {
  const reusable = args.force ? null : reuseBySrc.get(task.image.src)
  if (reusable) {
    return {
      id: reusable.id,
      sig: reusable.sig,
      status: "reused",
      sourceLocation: "reused",
      uploaded: 0,
      skipped: 0,
      photo: reusable.photo,
    }
  }

  return await indexAndUploadImage({
    args,
    config,
    existingPhotos,
    gallery: task.gallery,
    image: task.image,
    localSources,
    prefix,
  })
}

function buildCoarseSignatures(signatures) {
  if (signatures.length % SIG_BYTES) {
    throw new Error(`Full signatures size is not divisible by ${SIG_BYTES}: ${signatures.length}`)
  }
  const count = signatures.length / SIG_BYTES
  const coarse = Buffer.alloc(count * COARSE_SIG_BYTES)
  for (let i = 0; i < count; i++) {
    const start = i * SIG_BYTES
    const sig = signatures.subarray(start, start + SIG_BYTES)
    const downsampled = downsampleSig(sig)
    for (let j = 0; j < COARSE_LEN; j++) {
      // Store the exact sum of the 2x2 source block (downsampled value * 4).
      // The website worker divides by 4, preserving the current comparison math.
      coarse.writeUInt16LE(Math.round(downsampled[j] * 4), i * COARSE_SIG_BYTES + j * 2)
    }
  }
  return coarse
}

async function publishCoarseSignatures({ args, config, coarseSignatures }) {
  await uploadStorageBuffer({
    attempts: args.uploadAttempts,
    bucket: args.bucket,
    config,
    contentType: "application/octet-stream",
    data: coarseSignatures,
    force: true,
    objectPath: storagePath(args.prefix, COARSE_SIGNATURES_PATH),
    timeoutMs: args.uploadTimeoutMs,
  })
}

async function publishLibrary({ args, config, manifest, signatures, coarseSignatures }) {
  await uploadStorageBuffer({
    attempts: args.uploadAttempts,
    bucket: args.bucket,
    config,
    contentType: "application/json",
    data: Buffer.from(JSON.stringify(manifest, null, 2)),
    force: true,
    objectPath: storagePath(args.prefix, MANIFEST_PATH),
    timeoutMs: args.uploadTimeoutMs,
  })
  await uploadStorageBuffer({
    attempts: args.uploadAttempts,
    bucket: args.bucket,
    config,
    contentType: "application/octet-stream",
    data: signatures,
    force: true,
    objectPath: storagePath(args.prefix, SIGNATURES_PATH),
    timeoutMs: args.uploadTimeoutMs,
  })
  await publishCoarseSignatures({ args, config, coarseSignatures })
}

async function publishCoarseOnly({ args, config }) {
  const signatures = await fs.readFile(args.localSignatures)
  const coarseSignatures = buildCoarseSignatures(signatures)
  await ensureDir(path.dirname(args.localCoarseSignatures))
  await fs.writeFile(args.localCoarseSignatures, coarseSignatures)
  if (!args.dryRun) {
    await publishCoarseSignatures({ args, config, coarseSignatures })
  }

  console.log(
    `Built ${Math.floor(signatures.length / SIG_BYTES)} coarse signatures ` +
      `(${(coarseSignatures.length / 1e6).toFixed(1)} MB).`
  )
  console.log(`Local coarse signatures: ${path.relative(repoRoot, args.localCoarseSignatures)}`)
  if (!args.dryRun) {
    console.log(
      `Published: ${args.bucket}/${storagePath(args.prefix, COARSE_SIGNATURES_PATH)}`
    )
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(usageText())
    return
  }
  validateArgs(args)
  await loadEnvLocal()
  const config = supabaseConfig()
  if (args.coarseOnly) {
    await publishCoarseOnly({ args, config })
    return
  }
  const existingLibrary = args.dryRun
    ? { byId: new Map(), photos: [] }
    : await downloadExistingManifest({ bucket: args.bucket, config, prefix: args.prefix })
  const existingPhotos = existingLibrary.byId
  const existingSignatures =
    args.dryRun || args.force
      ? null
      : await downloadExistingSignatures({ bucket: args.bucket, config, prefix: args.prefix })
  const reuseBySrc =
    args.dryRun || args.force
      ? new Map()
      : buildReuseBySource({
          existingPhotos: existingLibrary.photos,
          existingSignatures,
        })
  const localSources = args.preferLocalSources
    ? await loadLocalSourceManifest(args.sourceManifest)
    : new Map()

  const tasks = []
  const photos = []
  const sigs = []
  const seenIds = new Set()
  const galleryRecords = []
  let droppedFlat = 0
  let failed = 0
  let reusedPhotos = 0
  let uploadedObjects = 0
  let skippedObjects = 0
  let localSourcePhotos = 0
  let remoteSourcePhotos = 0
  let processedGalleries = 0
  let processedSourcePhotos = 0
  let offset = args.offset
  let total = Infinity
  const collectionProgress = createCollectionReporter()
  const progress = createProgressReporter()

  console.log(
    `${args.dryRun ? "Indexing" : "Publishing"} Knicks photo library to ${args.bucket}` +
      (args.prefix ? ` under ${args.prefix}/` : " at bucket root")
  )
  if (existingPhotos.size && !args.force) {
    console.log(`Existing manifest has ${existingPhotos.size} photo id(s).`)
  }
  if (reuseBySrc.size && !args.force) {
    console.log(`Existing signatures match ${reuseBySrc.size} reusable source URL(s).`)
  }
  if (args.preferLocalSources) {
    console.log(
      `Local source manifest has ${localSources.size} reusable photo source(s): ` +
        `${path.relative(repoRoot, args.sourceManifest)}`
    )
  }

  while (offset < total) {
    const pageOffset = offset
    collectionProgress.start(pageOffset)
    const page = await fetchGalleryPageAdaptive({
      args,
      collectionProgress,
      count: args.count,
      offset: pageOffset,
    })
    const results = page.results ?? {}
    const items = results.items ?? []
    total = results.total ?? offset + items.length

    if (items.length === 0) break

    let pageGalleryCount = 0
    let pageSourcePhotos = 0
    for (const gallery of items) {
      if (args.limitGalleries && processedGalleries >= args.limitGalleries) {
        offset = total
        break
      }

      const images = collectImages(gallery.contentExpanded)
      const remainingPhotos = args.limitPhotos
        ? Math.max(0, args.limitPhotos - processedSourcePhotos)
        : images.length
      const selectedImages = images.slice(0, remainingPhotos)
      if (selectedImages.length === 0 && args.limitPhotos) {
        offset = total
        break
      }

      const galleryRecord = {
        id: gallery.id,
        slug: gallerySlug(gallery),
        title: gallery.title,
        permalink: gallery.permalink,
        published: gallery.date || gallery.dateGmt || null,
        imageCount: images.length,
        accepted: 0,
        reused: 0,
        droppedFlat: 0,
        failed: 0,
      }

      const galleryIndex = galleryRecords.length
      const taskGallery = {
        id: gallery.id,
        name: gallery.name,
        slug: gallery.slug,
        title: gallery.title,
      }
      galleryRecords.push(galleryRecord)
      for (const image of selectedImages) {
        tasks.push({ gallery: taskGallery, galleryIndex, image })
      }
      pageSourcePhotos += selectedImages.length

      processedGalleries++
      processedSourcePhotos += selectedImages.length
      pageGalleryCount++

      if (args.limitPhotos && processedSourcePhotos >= args.limitPhotos) {
        offset = total
        break
      }
    }

    collectionProgress.page({
      offset: pageOffset,
      total,
      galleryCount: pageGalleryCount,
      sourcePhotoCount: pageSourcePhotos,
    })

    offset += args.count
    if (offset < total && args.delayMs > 0) await sleep(args.delayMs)
  }

  collectionProgress.done(tasks.length)
  progress.addQueued(tasks.length)
  const taskResults = await mapLimit(tasks, args.concurrency, async (task) => {
    progress.start()
    let result
    try {
      result = await processImageTask({
        args,
        config,
        existingPhotos,
        localSources,
        prefix: args.prefix,
        reuseBySrc,
        task,
      })
    } catch (error) {
      result = { status: "failed", src: task.image.src, error: error.message }
    }
    progress.finish(result)
    return result
  })

  for (let index = 0; index < taskResults.length; index++) {
    const task = tasks[index]
    const result = taskResults[index]
    const galleryRecord = galleryRecords[task.galleryIndex]

    if (result.sourceLocation === "local") localSourcePhotos++
    else if (result.sourceLocation === "remote") remoteSourcePhotos++
    if (result.status === "flat") {
      droppedFlat++
      galleryRecord.droppedFlat++
      continue
    }
    if (result.status === "failed") {
      failed++
      galleryRecord.failed++
      progress.warn(`Failed ${result.src}: ${result.error}`)
      continue
    }

    uploadedObjects += result.uploaded ?? 0
    skippedObjects += result.skipped ?? 0
    if (result.status === "reused") {
      reusedPhotos++
      galleryRecord.reused++
    }
    if (seenIds.has(result.id)) continue
    seenIds.add(result.id)
    photos.push(result.photo)
    sigs.push(result.sig)
    galleryRecord.accepted++
  }

  for (let index = 0; index < galleryRecords.length; index++) {
    const galleryRecord = galleryRecords[index]
    progress.log(
      `[${index + 1}/${total}] ${galleryRecord.slug}: ${galleryRecord.accepted} accepted` +
        `${galleryRecord.reused ? `, ${galleryRecord.reused} reused` : ""}` +
        `${galleryRecord.droppedFlat ? `, ${galleryRecord.droppedFlat} flat` : ""}` +
        `${galleryRecord.failed ? `, ${galleryRecord.failed} failed` : ""}`
    )
  }

  progress.done()
  const signatures = Buffer.alloc(sigs.length * SIG_BYTES)
  for (let i = 0; i < sigs.length; i++) {
    signatures.set(sigs[i], i * SIG_BYTES)
  }
  const coarseSignatures = buildCoarseSignatures(signatures)

  const version = new Date().toISOString()
  const manifest = { version, photos }
  const localDetails = {
    version,
    source: "https://www.nba.com/knicks/photos",
    apiBase: API_BASE,
    bucket: args.bucket,
    prefix: args.prefix,
    options: {
      apiAttempts: args.apiAttempts,
      apiRetryDelayMs: args.apiRetryDelayMs,
      apiTimeoutMs: args.apiTimeoutMs,
      originalQuality: args.originalQuality,
      preferLocalSources: args.preferLocalSources,
      sourceManifest: path.relative(repoRoot, args.sourceManifest),
      sourceAttempts: args.sourceAttempts,
      sourceTimeoutMs: args.sourceTimeoutMs,
      thumbMax: args.thumbMax,
      thumbQuality: args.thumbQuality,
      uploadAttempts: args.uploadAttempts,
      uploadTimeoutMs: args.uploadTimeoutMs,
    },
    totalGalleries: total,
    processedGalleries,
    processedSourcePhotos,
    acceptedPhotos: photos.length,
    droppedFlat,
    failed,
    reusedPhotos,
    localSourcePhotos,
    remoteSourcePhotos,
    uploadedObjects,
    skippedObjects,
    storageManifestPath: storagePath(args.prefix, MANIFEST_PATH),
    storageSignaturesPath: storagePath(args.prefix, SIGNATURES_PATH),
    storageCoarseSignaturesPath: storagePath(args.prefix, COARSE_SIGNATURES_PATH),
    galleries: galleryRecords,
  }

  await ensureDir(path.dirname(args.localManifest))
  await writeJson(args.localManifest, localDetails)
  await ensureDir(path.dirname(args.localSignatures))
  await fs.writeFile(args.localSignatures, signatures)
  await ensureDir(path.dirname(args.localCoarseSignatures))
  await fs.writeFile(args.localCoarseSignatures, coarseSignatures)

  if (!args.dryRun) {
    await publishLibrary({ args, config, manifest, signatures, coarseSignatures })
  }

  console.log(
    `Done. ${photos.length} photos, ${reusedPhotos} reused, ${droppedFlat} flat, ${failed} failed, ` +
      `${uploadedObjects} objects uploaded, ${skippedObjects} objects skipped.`
  )
  console.log(`Local details: ${path.relative(repoRoot, args.localManifest)}`)
  console.log(`Local signatures: ${path.relative(repoRoot, args.localSignatures)}`)
  console.log(`Local coarse signatures: ${path.relative(repoRoot, args.localCoarseSignatures)}`)
  if (!args.dryRun) {
    console.log(
      `Published: ${args.bucket}/${storagePath(args.prefix, MANIFEST_PATH)}, ` +
        `${args.bucket}/${storagePath(args.prefix, SIGNATURES_PATH)}, and ` +
        `${args.bucket}/${storagePath(args.prefix, COARSE_SIGNATURES_PATH)}`
    )
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
