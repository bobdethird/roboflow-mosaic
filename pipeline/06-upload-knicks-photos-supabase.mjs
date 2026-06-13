import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { ensureDir, readJson, shortHash, writeJson } from "./lib/common.mjs"

const pipelineRoot = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(pipelineRoot, "..")

const TEAM_ID = "1610612752"
const API_BASE = `https://content-api-prod.nba.com/public/1/leagues/nba/teams/${TEAM_ID}/content`
const DEFAULT_BUCKET = "knicks-mosaic"
const DEFAULT_PREFIX = "nba-knicks-photos"
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"

function parseArgs(argv) {
  const args = {
    bucket: process.env.KNICKS_PHOTO_BUCKET || DEFAULT_BUCKET,
    count: 100,
    concurrency: 3,
    delayMs: 250,
    force: false,
    manifest: path.join(pipelineRoot, "data", "knicks-photos-supabase-manifest.json"),
    offset: 0,
    prefix: process.env.KNICKS_PHOTO_PREFIX || DEFAULT_PREFIX,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--bucket") args.bucket = argv[++i]
    else if (arg === "--count") args.count = Number(argv[++i])
    else if (arg === "--concurrency") args.concurrency = Number(argv[++i])
    else if (arg === "--delay-ms") args.delayMs = Number(argv[++i])
    else if (arg === "--force") args.force = true
    else if (arg === "--limit-galleries") args.limitGalleries = Number(argv[++i])
    else if (arg === "--limit-photos") args.limitPhotos = Number(argv[++i])
    else if (arg === "--manifest") args.manifest = path.resolve(argv[++i])
    else if (arg === "--offset") args.offset = Number(argv[++i])
    else if (arg === "--prefix") args.prefix = argv[++i]
    else if (arg === "--help") args.help = true
    else throw new Error(`Unknown argument: ${arg}`)
  }

  return args
}

function usageText() {
  return `Usage: node 06-upload-knicks-photos-supabase.mjs [options]

Streams Knicks photo galleries from the NBA CDN into Supabase Storage.

Required env:
  NEXT_PUBLIC_SUPABASE_URL
  SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY

Options:
  --bucket <name>          Storage bucket (default: knicks-mosaic)
  --prefix <path>          Object prefix (default: nba-knicks-photos)
  --count <n>              API page size (default: 100)
  --offset <n>             Start gallery offset (default: 0)
  --limit-galleries <n>    Stop after N galleries
  --limit-photos <n>       Stop after N photos
  --concurrency <n>        Parallel uploads (default: 3)
  --delay-ms <n>           Delay between API pages (default: 250)
  --manifest <path>        Resume manifest path
  --force                  Re-upload objects already marked uploaded
  --help                   Show this help
`
}

function validateArgs(args) {
  for (const [name, value] of [
    ["count", args.count],
    ["concurrency", args.concurrency],
    ["delay-ms", args.delayMs],
    ["offset", args.offset],
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

  if (!url) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL in the environment or .env.local")
  }
  if (!key) {
    throw new Error(
      "Missing SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY in the environment or .env.local"
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

function objectPrefix(prefix) {
  return prefix
    .split("/")
    .map((segment) => sanitizeSegment(segment, "photos"))
    .filter(Boolean)
    .join("/")
}

function imageExtension(src) {
  const pathname = new URL(src).pathname
  const ext = path.extname(pathname).toLowerCase()
  if ([".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(ext)) return ext
  return ".jpg"
}

function imageBasename(src) {
  const pathname = new URL(src).pathname
  const base = path.basename(pathname, path.extname(pathname))
  return sanitizeSegment(base, "image")
}

function contentTypeFor(src) {
  const ext = imageExtension(src)
  if (ext === ".png") return "image/png"
  if (ext === ".webp") return "image/webp"
  if (ext === ".gif") return "image/gif"
  return "image/jpeg"
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
        id: value.attributes.id || shortHash(value.attributes.src),
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
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      await worker(items[index], index)
    }
  })
  await Promise.all(workers)
}

function buildUploadTask({ gallery, image, imageIndex, prefix }) {
  const slug = gallerySlug(gallery)
  const ext = imageExtension(image.src)
  const safeBase = imageBasename(image.src)
  const id = sanitizeSegment(image.id, shortHash(image.src))
  const fileName = `${String(imageIndex + 1).padStart(3, "0")}-${id}-${safeBase}${ext}`
  return {
    ...image,
    contentType: contentTypeFor(image.src),
    objectPath: [objectPrefix(prefix), slug, fileName].filter(Boolean).join("/"),
  }
}

function uploadedSetFromManifest(manifest) {
  const out = new Set()
  for (const gallery of manifest.galleries ?? []) {
    for (const image of gallery.images ?? []) {
      if (image.status === "uploaded" && image.objectPath) out.add(image.objectPath)
    }
  }
  return out
}

async function uploadToSupabase({ config, bucket, force, task }) {
  if (!force && task.alreadyUploaded) return { status: "skipped" }

  const imageResponse = await fetchWithRetry(task.src)
  const buffer = Buffer.from(await imageResponse.arrayBuffer())
  const encodedPath = task.objectPath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")
  const uploadUrl = `${config.url}/storage/v1/object/${encodeURIComponent(bucket)}/${encodedPath}`
  const uploadResponse = await fetchWithRetry(uploadUrl, {
    body: buffer,
    headers: {
      apikey: config.key,
      authorization: `Bearer ${config.key}`,
      "cache-control": "31536000",
      "content-type": task.contentType,
      "x-upsert": force ? "true" : "false",
    },
    method: "POST",
  })

  return { status: "uploaded", bytes: buffer.length, storageResponse: await uploadResponse.json() }
}

async function uploadManifest({ config, bucket, manifest, prefix }) {
  const objectPath = [objectPrefix(prefix), "manifest.json"].filter(Boolean).join("/")
  const encodedPath = objectPath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")
  const uploadUrl = `${config.url}/storage/v1/object/${encodeURIComponent(bucket)}/${encodedPath}`
  await fetchWithRetry(uploadUrl, {
    body: JSON.stringify(manifest, null, 2),
    headers: {
      apikey: config.key,
      authorization: `Bearer ${config.key}`,
      "cache-control": "60",
      "content-type": "application/json",
      "x-upsert": "true",
    },
    method: "POST",
  })
  return objectPath
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

  const manifest =
    (await readJson(args.manifest, null)) ?? {
      generatedAt: null,
      source: "https://www.nba.com/knicks/photos",
      apiBase: API_BASE,
      bucket: args.bucket,
      prefix: objectPrefix(args.prefix),
      teamId: TEAM_ID,
      totalGalleries: null,
      processedGalleries: 0,
      uploadedPhotos: 0,
      skippedPhotos: 0,
      failedPhotos: 0,
      galleries: [],
    }

  manifest.bucket = args.bucket
  manifest.prefix = objectPrefix(args.prefix)

  const alreadyUploaded = uploadedSetFromManifest(manifest)
  let processedGalleries = 0
  let processedPhotos = 0
  let offset = args.offset
  let total = Infinity

  await ensureDir(path.dirname(args.manifest))
  console.log(
    `Uploading Knicks photos to bucket "${args.bucket}" under "${manifest.prefix}/"`
  )
  if (alreadyUploaded.size && !args.force) {
    console.log(`Resume manifest has ${alreadyUploaded.size} uploaded object(s).`)
  }

  while (offset < total) {
    const page = await fetchGalleryPage({ count: args.count, offset })
    const results = page.results ?? {}
    const items = results.items ?? []
    total = results.total ?? offset + items.length
    manifest.totalGalleries = total

    if (items.length === 0) break

    for (const gallery of items) {
      if (args.limitGalleries && processedGalleries >= args.limitGalleries) {
        offset = total
        break
      }

      const slug = gallerySlug(gallery)
      const images = collectImages(gallery.contentExpanded)
      const remainingPhotos = args.limitPhotos
        ? Math.max(0, args.limitPhotos - processedPhotos)
        : images.length
      const selectedImages = images.slice(0, remainingPhotos)

      if (selectedImages.length === 0 && args.limitPhotos) {
        offset = total
        break
      }

      const tasks = selectedImages.map((image, imageIndex) => {
        const task = buildUploadTask({
          gallery,
          image,
          imageIndex,
          prefix: manifest.prefix,
        })
        task.alreadyUploaded = alreadyUploaded.has(task.objectPath)
        return task
      })

      const galleryRecord = {
        id: gallery.id,
        slug,
        title: gallery.title,
        permalink: gallery.permalink,
        published: gallery.date || gallery.dateGmt || null,
        imageCount: images.length,
        images: tasks.map((task) => ({
          id: task.id,
          src: task.src,
          alt: task.alt,
          caption: task.caption,
          credit: task.credit,
          copyright: task.copyright,
          width: task.width,
          height: task.height,
          contentType: task.contentType,
          objectPath: task.objectPath,
          status: task.alreadyUploaded && !args.force ? "skipped" : "pending",
        })),
      }

      await mapLimit(tasks, args.concurrency, async (task, imageIndex) => {
        const record = galleryRecord.images[imageIndex]
        try {
          const result = await uploadToSupabase({
            bucket: args.bucket,
            config,
            force: args.force,
            task,
          })
          record.status = result.status
          if (result.bytes) record.bytes = result.bytes
          if (result.storageResponse) record.storageResponse = result.storageResponse
          if (result.status === "uploaded") {
            manifest.uploadedPhotos++
            alreadyUploaded.add(task.objectPath)
          } else if (result.status === "skipped") {
            manifest.skippedPhotos++
          }
        } catch (error) {
          record.status = "failed"
          record.error = error.message
          manifest.failedPhotos++
          console.warn(`Failed ${task.objectPath}: ${error.message}`)
        }
      })

      manifest.galleries.push(galleryRecord)
      manifest.processedGalleries++
      processedGalleries++
      processedPhotos += selectedImages.length

      console.log(
        `[${manifest.processedGalleries}/${total}] ${slug}: ${selectedImages.length}/${images.length} photos`
      )
      manifest.generatedAt = new Date().toISOString()
      await writeJson(args.manifest, manifest)

      if (args.limitPhotos && processedPhotos >= args.limitPhotos) {
        offset = total
        break
      }
    }

    offset += args.count
    if (offset < total && args.delayMs > 0) await sleep(args.delayMs)
  }

  manifest.generatedAt = new Date().toISOString()
  const manifestObjectPath = await uploadManifest({
    bucket: args.bucket,
    config,
    manifest,
    prefix: manifest.prefix,
  })
  manifest.storageManifestPath = manifestObjectPath
  await writeJson(args.manifest, manifest)

  console.log(
    `Done. Uploaded ${manifest.uploadedPhotos}, skipped ${manifest.skippedPhotos}, failed ${manifest.failedPhotos}.`
  )
  console.log(`Local resume manifest: ${path.relative(repoRoot, args.manifest)}`)
  console.log(`Storage manifest: ${args.bucket}/${manifestObjectPath}`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
