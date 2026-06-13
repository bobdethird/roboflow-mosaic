import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import sharp from "sharp"

import { ensureDir, shortHash, writeJson } from "./lib/common.mjs"
import { lumStd, SIG_BYTES, SIGNATURE_CHANNELS, SIGNATURE_GRID } from "./lib/signature.mjs"

const pipelineRoot = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(pipelineRoot, "..")

const TEAM_ID = "1610612752"
const API_BASE = `https://content-api-prod.nba.com/public/1/leagues/nba/teams/${TEAM_ID}/content`
const DEFAULT_BUCKET = "knicks-mosaic"
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"

const MANIFEST_PATH = "manifest.json"
const SIGNATURES_PATH = "signatures.bin"
const thumbPath = (id) => `thumbs/${id}.jpg`
const originalPath = (id) => `originals/${id}`

function parseArgs(argv) {
  const args = {
    bucket: process.env.KNICKS_PHOTO_BUCKET || DEFAULT_BUCKET,
    count: 100,
    concurrency: 4,
    delayMs: 250,
    dryRun: false,
    flatnessMin: envNumber("KNICKS_PHOTO_FLATNESS_MIN", 10),
    force: process.env.KNICKS_PHOTO_REUPLOAD === "1",
    localManifest: path.join(pipelineRoot, "data", "knicks-photo-library-manifest.json"),
    localSignatures: path.join(pipelineRoot, "data", "knicks-photo-library-signatures.bin"),
    offset: 0,
    prefix: process.env.KNICKS_PHOTO_LIBRARY_PREFIX || "",
    thumbMax: envNumber("KNICKS_PHOTO_THUMB_MAX", 200),
    thumbQuality: envNumber("KNICKS_PHOTO_THUMB_QUALITY", 82),
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--bucket") args.bucket = argv[++i]
    else if (arg === "--count") args.count = Number(argv[++i])
    else if (arg === "--concurrency") args.concurrency = Number(argv[++i])
    else if (arg === "--delay-ms") args.delayMs = Number(argv[++i])
    else if (arg === "--dry-run") args.dryRun = true
    else if (arg === "--flatness-min") args.flatnessMin = Number(argv[++i])
    else if (arg === "--force") args.force = true
    else if (arg === "--limit-galleries") args.limitGalleries = Number(argv[++i])
    else if (arg === "--limit-photos") args.limitPhotos = Number(argv[++i])
    else if (arg === "--local-manifest") args.localManifest = path.resolve(argv[++i])
    else if (arg === "--local-signatures") args.localSignatures = path.resolve(argv[++i])
    else if (arg === "--offset") args.offset = Number(argv[++i])
    else if (arg === "--prefix") args.prefix = argv[++i]
    else if (arg === "--thumb-max") args.thumbMax = Number(argv[++i])
    else if (arg === "--thumb-quality") args.thumbQuality = Number(argv[++i])
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
  thumbs/<id>.jpg
  originals/<id>

Required env:
  NEXT_PUBLIC_SUPABASE_URL
  SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY

Options:
  --bucket <name>          Storage bucket (default: knicks-mosaic)
  --prefix <path>          Optional object prefix for smoke tests
  --count <n>              API page size (default: 100)
  --offset <n>             Start gallery offset (default: 0)
  --limit-galleries <n>    Stop after N galleries
  --limit-photos <n>       Stop after N source photos
  --concurrency <n>        Parallel indexing/uploads (default: 4)
  --delay-ms <n>           Delay between API pages (default: 250)
  --flatness-min <n>       Drop near-flat signatures below this stddev (default: 10)
  --thumb-max <n>          Thumbnail long edge (default: 200)
  --thumb-quality <n>      JPEG thumbnail quality (default: 82)
  --force                  Re-upload thumbs/originals even if manifest has the id
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
    ["count", args.count],
    ["concurrency", args.concurrency],
    ["delay-ms", args.delayMs],
    ["flatness-min", args.flatnessMin],
    ["offset", args.offset],
    ["thumb-max", args.thumbMax],
    ["thumb-quality", args.thumbQuality],
  ]) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Invalid --${name}: ${value}`)
    }
  }
  if (args.count < 1 || args.count > 100) throw new Error("--count must be between 1 and 100")
  if (args.concurrency < 1) throw new Error("--concurrency must be at least 1")
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

function imageExtension(src) {
  const ext = path.extname(new URL(src).pathname).toLowerCase()
  if ([".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(ext)) return ext
  return ".jpg"
}

function contentTypeFor(src) {
  const ext = imageExtension(src)
  if (ext === ".png") return "image/png"
  if (ext === ".webp") return "image/webp"
  if (ext === ".gif") return "image/gif"
  return "image/jpeg"
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

async function fetchWithRetry(url, options = {}, attempts = 5) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          "user-agent": USER_AGENT,
          accept: "*/*",
          ...options.headers,
        },
      })
      if (response.ok) return response

      const body = await response.text().catch(() => "")
      lastError = new Error(
        `${response.status} ${response.statusText}: ${body.slice(0, 180)}`
      )
    } catch (error) {
      lastError = error
    }

    if (attempt < attempts) await sleep(750 * 2 ** (attempt - 1))
  }
  throw lastError
}

async function fetchGalleryPage({ count, offset }) {
  const url = new URL(API_BASE)
  url.searchParams.set("types", "gallery")
  url.searchParams.set("count", String(count))
  url.searchParams.set("offset", String(offset))
  url.searchParams.set("platform", "web")

  const response = await fetchWithRetry(url, {
    headers: { accept: "application/json" },
  })
  return await response.json()
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

async function downloadExistingManifest({ bucket, config, prefix }) {
  const objectPath = storagePath(prefix, MANIFEST_PATH)
  const url = `${config.url}/storage/v1/object/${encodeURIComponent(bucket)}/${encodeStoragePath(
    objectPath
  )}`
  try {
    const response = await fetch(url, {
      headers: {
        apikey: config.key,
        authorization: `Bearer ${config.key}`,
        accept: "application/json",
      },
    })
    if (!response.ok) return new Map()
    const manifest = await response.json()
    if (!Array.isArray(manifest.photos)) return new Map()
    return new Map(
      manifest.photos.filter((photo) => photo?.id).map((photo) => [photo.id, photo])
    )
  } catch {
    return new Map()
  }
}

async function uploadStorageBuffer({ bucket, config, contentType, data, force, objectPath }) {
  const url = `${config.url}/storage/v1/object/${encodeURIComponent(bucket)}/${encodeStoragePath(
    objectPath
  )}`
  const response = await fetch(url, {
    body: data,
    headers: {
      apikey: config.key,
      authorization: `Bearer ${config.key}`,
      "cache-control": "31536000",
      "content-type": contentType,
      "x-upsert": force ? "true" : "false",
    },
    method: "POST",
  })

  if (response.ok) return { uploaded: true }

  const text = await response.text().catch(() => "")
  if (response.status === 400 && /already exists/i.test(text)) {
    return { uploaded: false, skipped: true }
  }
  throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 180)}`)
}

async function indexAndUploadImage({ args, config, existingPhotos, gallery, image, prefix }) {
  const imageResponse = await fetchWithRetry(image.src)
  const original = Buffer.from(await imageResponse.arrayBuffer())
  const sig = await signatureFromBuffer(original)

  if (lumStd(sig) < args.flatnessMin) {
    return { status: "flat", src: image.src }
  }

  const id = hashId(original)
  const thumb = await renderThumb(original, args)
  const fullPath = originalPath(id)
  const storedThumbPath = storagePath(prefix, thumbPath(id))
  const storedOriginalPath = storagePath(prefix, fullPath)

  let uploaded = 0
  let skipped = 0
  const existing = existingPhotos.get(id)

  if (!args.dryRun && (args.force || !existing)) {
    const thumbResult = await uploadStorageBuffer({
      bucket: args.bucket,
      config,
      contentType: "image/jpeg",
      data: thumb.blob,
      force: args.force,
      objectPath: storedThumbPath,
    })
    const originalResult = await uploadStorageBuffer({
      bucket: args.bucket,
      config,
      contentType: contentTypeFor(image.src),
      data: original,
      force: args.force,
      objectPath: storedOriginalPath,
    })
    uploaded += Number(Boolean(thumbResult.uploaded)) + Number(Boolean(originalResult.uploaded))
    skipped += Number(Boolean(thumbResult.skipped)) + Number(Boolean(originalResult.skipped))
  } else if (existing) {
    skipped += 2
  }

  return {
    id,
    sig,
    status: args.dryRun ? "indexed" : "uploaded",
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

async function publishLibrary({ args, config, manifest, signatures }) {
  await uploadStorageBuffer({
    bucket: args.bucket,
    config,
    contentType: "application/json",
    data: Buffer.from(JSON.stringify(manifest, null, 2)),
    force: true,
    objectPath: storagePath(args.prefix, MANIFEST_PATH),
  })
  await uploadStorageBuffer({
    bucket: args.bucket,
    config,
    contentType: "application/octet-stream",
    data: signatures,
    force: true,
    objectPath: storagePath(args.prefix, SIGNATURES_PATH),
  })
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
  const existingPhotos = args.dryRun
    ? new Map()
    : await downloadExistingManifest({ bucket: args.bucket, config, prefix: args.prefix })

  const photos = []
  const sigs = []
  const seenIds = new Set()
  const manifestDetails = []
  let droppedFlat = 0
  let failed = 0
  let uploadedObjects = 0
  let skippedObjects = 0
  let processedGalleries = 0
  let processedSourcePhotos = 0
  let offset = args.offset
  let total = Infinity

  console.log(
    `${args.dryRun ? "Indexing" : "Publishing"} Knicks photo library to ${args.bucket}` +
      (args.prefix ? ` under ${args.prefix}/` : " at bucket root")
  )
  if (existingPhotos.size && !args.force) {
    console.log(`Existing manifest has ${existingPhotos.size} photo id(s).`)
  }

  while (offset < total) {
    const page = await fetchGalleryPage({ count: args.count, offset })
    const results = page.results ?? {}
    const items = results.items ?? []
    total = results.total ?? offset + items.length

    if (items.length === 0) break

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

      const resultsForGallery = await mapLimit(
        selectedImages,
        args.concurrency,
        async (image) => {
          try {
            return await indexAndUploadImage({
              args,
              config,
              existingPhotos,
              gallery,
              image,
              prefix: args.prefix,
            })
          } catch (error) {
            return { status: "failed", src: image.src, error: error.message }
          }
        }
      )

      const galleryRecord = {
        id: gallery.id,
        slug: gallerySlug(gallery),
        title: gallery.title,
        permalink: gallery.permalink,
        published: gallery.date || gallery.dateGmt || null,
        imageCount: images.length,
        accepted: 0,
        droppedFlat: 0,
        failed: 0,
      }

      for (const result of resultsForGallery) {
        if (result.status === "flat") {
          droppedFlat++
          galleryRecord.droppedFlat++
          continue
        }
        if (result.status === "failed") {
          failed++
          galleryRecord.failed++
          console.warn(`Failed ${result.src}: ${result.error}`)
          continue
        }
        uploadedObjects += result.uploaded
        skippedObjects += result.skipped
        if (seenIds.has(result.id)) continue
        seenIds.add(result.id)
        photos.push(result.photo)
        sigs.push(result.sig)
        galleryRecord.accepted++
      }

      manifestDetails.push(galleryRecord)
      processedGalleries++
      processedSourcePhotos += selectedImages.length

      console.log(
        `[${processedGalleries}/${total}] ${galleryRecord.slug}: ${galleryRecord.accepted} accepted` +
          `${galleryRecord.droppedFlat ? `, ${galleryRecord.droppedFlat} flat` : ""}` +
          `${galleryRecord.failed ? `, ${galleryRecord.failed} failed` : ""}`
      )

      if (args.limitPhotos && processedSourcePhotos >= args.limitPhotos) {
        offset = total
        break
      }
    }

    offset += args.count
    if (offset < total && args.delayMs > 0) await sleep(args.delayMs)
  }

  const signatures = Buffer.alloc(sigs.length * SIG_BYTES)
  for (let i = 0; i < sigs.length; i++) {
    signatures.set(sigs[i], i * SIG_BYTES)
  }

  const version = new Date().toISOString()
  const manifest = { version, photos }
  const localDetails = {
    version,
    source: "https://www.nba.com/knicks/photos",
    apiBase: API_BASE,
    bucket: args.bucket,
    prefix: args.prefix,
    totalGalleries: total,
    processedGalleries,
    processedSourcePhotos,
    acceptedPhotos: photos.length,
    droppedFlat,
    failed,
    uploadedObjects,
    skippedObjects,
    storageManifestPath: storagePath(args.prefix, MANIFEST_PATH),
    storageSignaturesPath: storagePath(args.prefix, SIGNATURES_PATH),
    galleries: manifestDetails,
  }

  await ensureDir(path.dirname(args.localManifest))
  await writeJson(args.localManifest, localDetails)
  await ensureDir(path.dirname(args.localSignatures))
  await fs.writeFile(args.localSignatures, signatures)

  if (!args.dryRun) {
    await publishLibrary({ args, config, manifest, signatures })
  }

  console.log(
    `Done. ${photos.length} photos, ${droppedFlat} flat, ${failed} failed, ` +
      `${uploadedObjects} objects uploaded, ${skippedObjects} objects skipped.`
  )
  console.log(`Local details: ${path.relative(repoRoot, args.localManifest)}`)
  console.log(`Local signatures: ${path.relative(repoRoot, args.localSignatures)}`)
  if (!args.dryRun) {
    console.log(
      `Published: ${args.bucket}/${storagePath(args.prefix, MANIFEST_PATH)} and ` +
        `${args.bucket}/${storagePath(args.prefix, SIGNATURES_PATH)}`
    )
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
