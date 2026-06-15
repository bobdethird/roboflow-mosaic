import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { ensureDir, exists, shortHash, writeJson } from "./lib/common.mjs"

const pipelineRoot = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(pipelineRoot, "..")

const TEAM_ID = "1610612752"
const API_BASE = `https://content-api-prod.nba.com/public/1/leagues/nba/teams/${TEAM_ID}/content`
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"

function parseArgs(argv) {
  const args = {
    count: 100,
    concurrency: 4,
    delayMs: 150,
    offset: 0,
    out: path.join(repoRoot, "photos"),
    force: false,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--out") args.out = path.resolve(argv[++i])
    else if (arg === "--count") args.count = Number(argv[++i])
    else if (arg === "--concurrency") args.concurrency = Number(argv[++i])
    else if (arg === "--delay-ms") args.delayMs = Number(argv[++i])
    else if (arg === "--offset") args.offset = Number(argv[++i])
    else if (arg === "--limit-galleries") args.limitGalleries = Number(argv[++i])
    else if (arg === "--limit-photos") args.limitPhotos = Number(argv[++i])
    else if (arg === "--force") args.force = true
    else if (arg === "--help") args.help = true
    else throw new Error(`Unknown argument: ${arg}`)
  }

  return args
}

function usageText() {
  return `Usage: node 05-download-knicks-photos.mjs [options]

Downloads Knicks photo galleries from the NBA content API into ../photos.

Options:
  --out <dir>              Output directory (default: ../photos)
  --count <n>              API page size (default: 100)
  --offset <n>             Start gallery offset (default: 0)
  --limit-galleries <n>    Stop after N galleries
  --limit-photos <n>       Stop after N photos
  --concurrency <n>        Parallel image downloads (default: 4)
  --delay-ms <n>           Delay between API pages (default: 150)
  --force                  Re-download files that already exist
  --help                   Show this help
`
}

function validateArgs(args) {
  for (const [name, value] of [
    ["count", args.count],
    ["concurrency", args.concurrency],
    ["delayMs", args.delayMs],
    ["offset", args.offset],
  ]) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Invalid --${name}: ${value}`)
    }
  }
  if (args.count < 1 || args.count > 100) {
    throw new Error("--count must be between 1 and 100")
  }
  if (args.concurrency < 1) {
    throw new Error("--concurrency must be at least 1")
  }
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

function relativePath(filePath) {
  return path.relative(repoRoot, filePath)
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

async function fetchWithRetry(url, options = {}, attempts = 4) {
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
        `${response.status} ${response.statusText}: ${body.slice(0, 160)}`
      )
    } catch (error) {
      lastError = error
    }

    if (attempt < attempts) {
      await sleep(500 * 2 ** (attempt - 1))
    }
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

async function downloadImage({ src, outputPath, force }) {
  await ensureDir(path.dirname(outputPath))

  if (!force && (await exists(outputPath))) {
    return { status: "skipped" }
  }

  const response = await fetchWithRetry(src)
  const buffer = Buffer.from(await response.arrayBuffer())
  const tmpPath = `${outputPath}.tmp-${process.pid}`
  await fs.writeFile(tmpPath, buffer)
  await fs.rename(tmpPath, outputPath)
  return { status: "downloaded", bytes: buffer.length }
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

function buildImageTask({ gallery, image, imageIndex, outDir }) {
  const slug = gallerySlug(gallery)
  const ext = imageExtension(image.src)
  const safeBase = imageBasename(image.src)
  const id = sanitizeSegment(image.id, shortHash(image.src))
  const fileName = `${String(imageIndex + 1).padStart(3, "0")}-${id}-${safeBase}${ext}`
  return {
    ...image,
    outputPath: path.join(outDir, slug, fileName),
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(usageText())
    return
  }
  validateArgs(args)

  const outDir = path.resolve(args.out)
  const manifestPath = path.join(outDir, "manifest.json")
  await ensureDir(outDir)

  const manifest = {
    generatedAt: new Date().toISOString(),
    source: "https://www.nba.com/knicks/photos",
    apiBase: API_BASE,
    teamId: TEAM_ID,
    totalGalleries: null,
    processedGalleries: 0,
    downloadedPhotos: 0,
    skippedPhotos: 0,
    failedPhotos: 0,
    galleries: [],
  }

  let processedGalleries = 0
  let processedPhotos = 0
  let offset = args.offset
  let total = Infinity

  console.log(`Saving Knicks photos to ${relativePath(outDir)}`)

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

      const galleryRecord = {
        id: gallery.id,
        slug,
        title: gallery.title,
        permalink: gallery.permalink,
        published: gallery.date || gallery.dateGmt || null,
        imageCount: images.length,
        images: selectedImages.map((image, imageIndex) => {
          const task = buildImageTask({ gallery, image, imageIndex, outDir })
          return {
            id: task.id,
            src: task.src,
            alt: task.alt,
            caption: task.caption,
            credit: task.credit,
            copyright: task.copyright,
            width: task.width,
            height: task.height,
            outputPath: relativePath(task.outputPath),
            status: "pending",
          }
        }),
      }

      const tasks = selectedImages.map((image, imageIndex) =>
        buildImageTask({ gallery, image, imageIndex, outDir })
      )

      await mapLimit(tasks, args.concurrency, async (task, imageIndex) => {
        const record = galleryRecord.images[imageIndex]
        try {
          const result = await downloadImage({
            src: task.src,
            outputPath: task.outputPath,
            force: args.force,
          })
          record.status = result.status
          if (result.bytes) record.bytes = result.bytes
          if (result.status === "downloaded") manifest.downloadedPhotos++
          else if (result.status === "skipped") manifest.skippedPhotos++
        } catch (error) {
          record.status = "failed"
          record.error = error.message
          manifest.failedPhotos++
          console.warn(`Failed ${task.src}: ${error.message}`)
        }
      })

      manifest.galleries.push(galleryRecord)
      manifest.processedGalleries++
      processedGalleries++
      processedPhotos += selectedImages.length

      console.log(
        `[${manifest.processedGalleries}/${total}] ${slug}: ${selectedImages.length}/${images.length} photos`
      )
      await writeJson(manifestPath, manifest)

      if (args.limitPhotos && processedPhotos >= args.limitPhotos) {
        offset = total
        break
      }
    }

    offset += args.count
    if (offset < total && args.delayMs > 0) await sleep(args.delayMs)
  }

  manifest.generatedAt = new Date().toISOString()
  await writeJson(manifestPath, manifest)

  console.log(
    `Done. Downloaded ${manifest.downloadedPhotos}, skipped ${manifest.skippedPhotos}, failed ${manifest.failedPhotos}.`
  )
  console.log(`Manifest: ${relativePath(manifestPath)}`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
