// Turns a Roboflow Universe dataset into the mosaic's tile library.
//
// Pipeline:
//   1. resolve the dataset version and ask Roboflow for a zip export link
//   2. stream the zip down
//   3. one decode per image → content-addressed id, 16×16 colour signature,
//      and a thumbnail
//   4. write manifest.json + signatures-coarse.bin + thumbs/
//
// Steps 3–4 are shared with the local-directory ingest (scripts/ingest-dir.mts),
// so any folder of images can be mosaicked the same way.
//
// What the mosaic reproduces is chosen in the browser afterwards — the project
// cover, or any single image out of the dataset — so the ingest does not build
// a reference image of its own.
//
// Everything written here ends up in one zip that the browser downloads whole
// (lib/roboflow-pack.ts), which is why the thumbnails are sized for the client
// rather than for an image CDN.

import { createHash } from "node:crypto"
import { createWriteStream } from "node:fs"
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"

import sharp from "sharp"
import yauzl from "yauzl"

import {
  COARSE_SIGNATURES_FILE,
  ICON_FILE,
  MANIFEST_FILE,
  datasetSlug,
  universeUrl,
  type RoboflowDataset,
  type RoboflowRef,
} from "./roboflow"
import {
  exportFormats,
  fetchExportLink,
  fetchProjectInfo,
} from "./roboflow-api"
import {
  blobEnabled,
  blobHasDataset,
  blobHasIcon,
  publishDataset,
} from "./roboflow-blob"
import { datasetDir, type ProgressReporter } from "./roboflow-store"

// Must match lib/mosaic.ts SIGNATURE_GRID and the worker's COARSE_GRID: the
// browser compares tiles on 8×8×3 values stored as uint16 LE fixed-point, where
// each stored value is the sum of a 2×2 block of the 16×16 uint8 signature
// (the worker multiplies by 0.25 to recover the mean).
const SIG_GRID = 16
const COARSE_GRID = SIG_GRID >> 1
const COARSE_VALUES = COARSE_GRID * COARSE_GRID * 3

// Thumbnails are the only image the browser ever gets: the whole library ships
// as one zip and every consumer reads it locally. 192px covers all of them —
// the mosaic canvas downsamples to 128, and the hover popup shows ~224 CSS px.
// Going higher multiplies the download for pixels only a retina hover would
// notice (a 3,995-image dataset: 15 MB at 128, 30 MB at 192, 81 MB at 384).
const THUMB_LONG_EDGE = 192
const THUMB_QUALITY = 80
// Long edge the project cover image is stored at. Matches the mosaic frame in
// lib/mosaic-bake.ts — the engine never draws the reference bigger than this.
const ICON_MAX_EDGE = 1600
// Hobby functions are 1 vCPU; eight Sharp pipelines just contend. Local
// machines can keep more in flight.
const CONCURRENCY = process.env.VERCEL ? 3 : 8

const IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".bmp",
  ".tif",
  ".tiff",
  ".avif",
])

export class IngestError extends Error {}

function isImagePath(name: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase())
}

// ─── Zip download + extraction ───────────────────────────────────────────────

async function downloadZip(
  link: string,
  destination: string,
  report: ProgressReporter
): Promise<void> {
  const response = await fetch(link)
  if (!response.ok || !response.body) {
    throw new IngestError(
      `Downloading the dataset export failed (${response.status} ${response.statusText}).`
    )
  }
  const total = Number(response.headers.get("content-length") ?? 0)
  let received = 0
  const source = Readable.fromWeb(
    response.body as Parameters<typeof Readable.fromWeb>[0]
  )
  source.on("data", (chunk: Buffer) => {
    received += chunk.length
    report("Downloading export", received, total)
  })
  await pipeline(source, createWriteStream(destination))
}

function openZip(file: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: true }, (error, zip) => {
      if (error || !zip) reject(error ?? new IngestError("Could not open the export zip."))
      else resolve(zip)
    })
  })
}

// Extract every image entry into one flat directory. Roboflow exports nest
// images under train/valid/test (and sometimes a class folder), none of which
// matters here — the mosaic just wants the pixels. Names are prefixed with the
// entry index so same-named files across splits can't collide.
async function extractImages(
  zipPath: string,
  destination: string,
  report: ProgressReporter
): Promise<string[]> {
  await mkdir(destination, { recursive: true })
  const zip = await openZip(zipPath)
  const written: string[] = []

  await new Promise<void>((resolve, reject) => {
    let index = 0
    const total = zip.entryCount

    zip.on("entry", (entry: yauzl.Entry) => {
      index += 1
      if (entry.fileName.endsWith("/") || !isImagePath(entry.fileName)) {
        zip.readEntry()
        return
      }
      zip.openReadStream(entry, (error, stream) => {
        if (error || !stream) {
          reject(error ?? new IngestError(`Could not read ${entry.fileName}`))
          return
        }
        const safe = path.basename(entry.fileName).replace(/[^\w.-]+/g, "_")
        const target = path.join(destination, `${written.length}-${safe}`)
        pipeline(stream, createWriteStream(target))
          .then(() => {
            written.push(target)
            report("Extracting images", index, total)
            zip.readEntry()
          })
          .catch(reject)
      })
    })
    zip.on("end", resolve)
    zip.on("error", reject)
    zip.readEntry()
  })

  if (!written.length) {
    throw new IngestError("The dataset export contained no images.")
  }
  return written
}

function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    stream.on("data", (chunk: Buffer) => chunks.push(chunk))
    stream.on("end", () => resolve(Buffer.concat(chunks)))
    stream.on("error", reject)
  })
}

function readZipEntry(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(error ?? new IngestError(`Could not read ${entry.fileName}`))
        return
      }
      streamToBuffer(stream).then(resolve, reject)
    })
  })
}

// Names of image entries, without decompressing them. Sorting these fixes the
// manifest order — and so the signature order — independently of zip order.
async function zipImageNames(zipPath: string): Promise<string[]> {
  const zip = await openZip(zipPath)
  const names: string[] = []
  await new Promise<void>((resolve, reject) => {
    zip.on("entry", (entry: yauzl.Entry) => {
      if (!entry.fileName.endsWith("/") && isImagePath(entry.fileName)) {
        names.push(entry.fileName)
      }
      zip.readEntry()
    })
    zip.on("end", resolve)
    zip.on("error", reject)
    zip.readEntry()
  })
  return names
}

// Walk image entries in zip order. `visit` runs with a bounded number in
// flight; the next entry is not decompressed until a slot is free, so a large
// export cannot pile up in memory.
async function forEachZipImage(
  zipPath: string,
  visit: (fileName: string, bytes: Buffer) => Promise<void>,
  shouldRead: (fileName: string) => boolean = () => true
): Promise<void> {
  const zip = await openZip(zipPath)
  let chain = Promise.resolve()
  let active = 0
  const waiting: Array<() => void> = []
  const tasks: Promise<void>[] = []

  const acquire = () =>
    new Promise<void>((resolve) => {
      if (active < CONCURRENCY) {
        active += 1
        resolve()
        return
      }
      waiting.push(resolve)
    })

  const release = () => {
    const next = waiting.shift()
    if (next) next()
    else active -= 1
  }

  await new Promise<void>((resolve, reject) => {
    zip.on("entry", (entry: yauzl.Entry) => {
      chain = chain
        .then(async () => {
          if (entry.fileName.endsWith("/") || !isImagePath(entry.fileName)) {
            zip.readEntry()
            return
          }
          if (!shouldRead(entry.fileName)) {
            zip.readEntry()
            return
          }
          const bytes = await readZipEntry(zip, entry)
          await acquire()
          tasks.push(visit(entry.fileName, bytes).catch(reject).finally(release))
          zip.readEntry()
        })
        .catch(reject)
    })
    zip.on("end", () => {
      chain.then(() => Promise.all(tasks)).then(() => resolve()).catch(reject)
    })
    zip.on("error", reject)
    zip.readEntry()
  })
}

// ─── Per-image work ──────────────────────────────────────────────────────────

// The 16×16 centre crop the tile signature is computed from.
async function signatureGrid(pipeline: sharp.Sharp): Promise<Buffer> {
  const { data, info } = await pipeline
    .resize(SIG_GRID, SIG_GRID, { fit: "cover", position: "centre" })
    .flatten({ background: "#ffffff" })
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true })
  if (info.channels !== 3) {
    throw new IngestError(`Unexpected channel count ${info.channels}`)
  }
  return data
}

// The two things every tile needs: its coarse colour signature and its
// thumbnail. Both are cloned off one Sharp instance — that does not share the
// JPEG decode (measured: it is no faster than two independent pipelines), but
// libvips shrinks on load for both targets, so neither ever decodes full size.
async function decodeOutputs(
  bytes: Buffer,
  thumbPath: string
): Promise<{ width: number; height: number; signature: Buffer }> {
  const image = sharp(bytes, { failOn: "none" })
  const metadata = await image.metadata()

  const [signature] = await Promise.all([
    signatureGrid(image.clone()).then(coarseSignature),
    image
      .clone()
      .resize(THUMB_LONG_EDGE, THUMB_LONG_EDGE, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: THUMB_QUALITY })
      .toFile(thumbPath),
  ])

  return {
    width: metadata.width ?? 0,
    height: metadata.height ?? 0,
    signature,
  }
}

// Pack a 16×16×3 uint8 signature into the worker's coarse uint16 LE format.
function coarseSignature(sig: Buffer): Buffer {
  const out = Buffer.allocUnsafe(COARSE_VALUES * 2)
  for (let by = 0; by < COARSE_GRID; by++) {
    for (let bx = 0; bx < COARSE_GRID; bx++) {
      for (let channel = 0; channel < 3; channel++) {
        let sum = 0
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            sum += sig[((by * 2 + dy) * SIG_GRID + (bx * 2 + dx)) * 3 + channel]
          }
        }
        // Stored as the exact 0..1020 sum; the worker scales by 0.25.
        out.writeUInt16LE(sum, ((by * COARSE_GRID + bx) * 3 + channel) * 2)
      }
    }
  }
  return out
}

// Run `task` over `items` with a bounded number in flight.
async function pooled<T>(
  items: T[],
  limit: number,
  task: (item: T, index: number) => Promise<void>
): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      await task(items[index], index)
    }
  })
  await Promise.all(workers)
}

export type ManifestPhoto = { id: string; w: number; h: number; file: string }
export type LibraryResult = {
  photoCount: number
  skipped: number
  // Manifest version this build stamped. The browser keys its cached copy of
  // the library on it, so a re-ingest invalidates that copy without a fetch.
  version: string
}

// Build the tile library from a directory of images and write it into
// `outputDir` in the layout the browser engine expects.
export async function buildLibrary(
  imageFiles: string[],
  outputDir: string,
  report: ProgressReporter
): Promise<LibraryResult> {
  const files = [...imageFiles].sort()
  const thumbsDir = path.join(outputDir, "thumbs")
  await mkdir(thumbsDir, { recursive: true })

  const photos: (ManifestPhoto | null)[] = new Array(files.length).fill(null)
  const signatures: (Buffer | null)[] = new Array(files.length).fill(null)
  const seen = new Set<string>()
  let processed = 0
  let skipped = 0

  await pooled(files, CONCURRENCY, async (file, index) => {
    try {
      const bytes = await readFile(file)
      const id = createHash("sha1").update(bytes).digest("hex").slice(0, 16)
      // A byte-identical duplicate already has its thumbnail and signature.
      if (seen.has(id)) return
      seen.add(id)

      const decoded = await decodeOutputs(
        bytes,
        path.join(thumbsDir, `${id}.jpg`)
      )
      photos[index] = {
        id,
        w: decoded.width,
        h: decoded.height,
        file: path.basename(file),
      }
      signatures[index] = decoded.signature
    } catch {
      skipped += 1
    } finally {
      processed += 1
      report("Building tiles", processed, files.length)
    }
  })

  const keptPhotos: ManifestPhoto[] = []
  const keptSignatures: Buffer[] = []
  for (let i = 0; i < files.length; i++) {
    const photo = photos[i]
    const signature = signatures[i]
    if (photo && signature) {
      keptPhotos.push(photo)
      keptSignatures.push(signature)
    }
  }
  if (!keptPhotos.length) {
    throw new IngestError("None of the dataset's images could be read.")
  }

  const version = await writeLibrary(outputDir, keptPhotos, keptSignatures, report)

  return { photoCount: keptPhotos.length, skipped, version }
}

async function writeLibrary(
  outputDir: string,
  photos: ManifestPhoto[],
  signatures: Buffer[],
  report: ProgressReporter
): Promise<string> {
  report("Writing library", 0, 0)
  const version = new Date().toISOString()
  await writeFile(
    path.join(outputDir, COARSE_SIGNATURES_FILE),
    Buffer.concat(signatures)
  )
  await writeFile(
    path.join(outputDir, MANIFEST_FILE),
    JSON.stringify({ version, photos }, null, 2)
  )
  return version
}

// Same outputs as `buildLibrary`, but images are decoded straight from the
// export zip so the full-resolution originals never land on disk.
async function buildLibraryFromZip(
  zipPath: string,
  outputDir: string,
  report: ProgressReporter
): Promise<LibraryResult> {
  report("Listing images", 0, 0)
  const names = (await zipImageNames(zipPath)).sort()
  if (!names.length) {
    throw new IngestError("The dataset export contained no images.")
  }

  const thumbsDir = path.join(outputDir, "thumbs")
  await mkdir(thumbsDir, { recursive: true })

  const byName = new Map<string, { photo: ManifestPhoto; signature: Buffer }>()
  const seen = new Set<string>()
  let processed = 0
  let skipped = 0

  await forEachZipImage(zipPath, async (fileName, bytes) => {
    try {
      const id = createHash("sha1").update(bytes).digest("hex").slice(0, 16)
      // A byte-identical duplicate already has its thumbnail and signature.
      if (seen.has(id)) return
      seen.add(id)

      const decoded = await decodeOutputs(
        bytes,
        path.join(thumbsDir, `${id}.jpg`)
      )
      byName.set(fileName, {
        photo: {
          id,
          w: decoded.width,
          h: decoded.height,
          file: path.basename(fileName),
        },
        signature: decoded.signature,
      })
    } catch {
      skipped += 1
    } finally {
      processed += 1
      report("Building tiles", processed, names.length)
    }
  })

  const keptPhotos: ManifestPhoto[] = []
  const keptSignatures: Buffer[] = []
  for (const name of names) {
    const kept = byName.get(name)
    if (!kept) continue
    keptPhotos.push(kept.photo)
    keptSignatures.push(kept.signature)
  }
  if (!keptPhotos.length) {
    throw new IngestError("None of the dataset's images could be read.")
  }

  const version = await writeLibrary(outputDir, keptPhotos, keptSignatures, report)

  return { photoCount: keptPhotos.length, skipped, version }
}

// ─── Orchestration ───────────────────────────────────────────────────────────

// The project's cover image — whatever single image the dataset's author picked
// to represent it, and the default thing the mosaic reproduces.
//
// Capped at the mosaic's own frame size (no crop, aspect preserved) because the
// originals run to several megapixels and the engine never draws the reference
// larger than this. A failure here is not fatal: the picker can still offer any
// image out of the dataset.
async function downloadIcon(url: string, destination: string): Promise<boolean> {
  try {
    const response = await fetch(url)
    if (!response.ok) return false
    const bytes = Buffer.from(await response.arrayBuffer())
    await sharp(bytes, { failOn: "none" })
      .rotate() // honour EXIF orientation before the dimensions are baked in
      .resize(ICON_MAX_EDGE, ICON_MAX_EDGE, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 92 })
      .toFile(destination)
    return true
  } catch {
    return false
  }
}

export async function resolveDataset(ref: RoboflowRef): Promise<{
  ref: RoboflowRef & { version: number }
  name: string
  type?: string
  images: number
  iconUrl?: string
}> {
  const info = await fetchProjectInfo(ref)
  const version = ref.version ?? info.latestVersion
  if (version === null) {
    throw new IngestError(
      `${info.name} has no generated dataset versions yet — open it on Roboflow ` +
        "Universe and pick a version, then paste that URL."
    )
  }
  if (ref.version !== null && !info.versions.includes(version)) {
    throw new IngestError(
      `Version ${version} does not exist. Available versions: ${info.versions.join(", ") || "none"}.`
    )
  }
  return {
    ref: { ...ref, version },
    name: info.name,
    type: info.type,
    images: info.imagesByVersion.get(version) ?? 0,
    iconUrl: info.iconUrl,
  }
}

export type IngestOptions = {
  // Also extract the original images under source/. Off by default: the
  // thumbnails are what the mosaic draws, and exports can be gigabytes.
  keepSource?: boolean
}

export async function ingestDataset(
  ref: RoboflowRef,
  report: ProgressReporter,
  options: IngestOptions = {}
): Promise<RoboflowDataset> {
  report("Resolving dataset", 0, 0)
  const resolved = await resolveDataset(ref)
  const slug = datasetSlug(resolved.ref)
  const outputDir = datasetDir(slug)
  const zipPath = path.join(outputDir, "export.zip")
  await mkdir(outputDir, { recursive: true })

  try {
    report("Requesting export", 0, 0)
    const { link } = await fetchExportLink(
      resolved.ref,
      exportFormats(resolved.type),
      (message) => report(message, 0, 0)
    )

    await downloadZip(link, zipPath, report)

    let hasIcon = false
    if (resolved.iconUrl) {
      report("Fetching project cover image", 0, 0)
      hasIcon = await downloadIcon(
        resolved.iconUrl,
        path.join(outputDir, ICON_FILE)
      )
    }

    const result = options.keepSource
      ? await buildLibrary(
          await extractImages(zipPath, path.join(outputDir, "source"), report),
          outputDir,
          report
        )
      : await buildLibraryFromZip(zipPath, outputDir, report)
    if (blobEnabled()) await publishDataset(slug, outputDir, report)

    return {
      ...resolved.ref,
      slug,
      name: resolved.name,
      type: resolved.type,
      imageCount: result.photoCount,
      universeUrl: universeUrl(resolved.ref),
      hasIcon,
      libraryVersion: result.version,
    }
  } finally {
    await rm(zipPath, { force: true })
  }
}

// Did this ingest save a project cover image?
export async function hasIconFile(slug: string): Promise<boolean> {
  try {
    await stat(path.join(datasetDir(slug), ICON_FILE))
    return true
  } catch {
    return blobEnabled() ? blobHasIcon(slug) : false
  }
}

async function isIngestedLocally(slug: string): Promise<boolean> {
  try {
    const dir = datasetDir(slug)
    await stat(path.join(dir, MANIFEST_FILE))
    await stat(path.join(dir, COARSE_SIGNATURES_FILE))
    const thumbs = await readdir(path.join(dir, "thumbs"))
    return thumbs.length > 0
  } catch {
    return false
  }
}

// Has this dataset already been ingested? Used to short-circuit a repeat
// request. A published dataset counts even on an instance whose cache is
// empty — that is the whole point of publishing it.
export async function isIngested(slug: string): Promise<boolean> {
  if (await isIngestedLocally(slug)) return true
  return blobEnabled() ? blobHasDataset(slug) : false
}
