// Turns a Roboflow Universe dataset into a mosaic tile library plus the
// reference image the mosaic is built from.
//
// Pipeline:
//   1. resolve the dataset version and ask Roboflow for a zip export link
//   2. stream the zip down and extract just its images
//   3. one pass per image → content-addressed id, 16×16 colour signature,
//      thumbnail, and a contribution to the dataset's median image
//   4. write manifest.json + signatures-coarse.bin + thumbs/ + reference.jpg
//
// Steps 3–4 are shared with the local-directory ingest (scripts/ingest-dir.ts),
// so any folder of images can be mosaicked the same way.
//
// The reference is the dataset's **median image**: the per-pixel, per-channel
// median across every sampled image. A median (rather than a mean) keeps the
// dataset's dominant structure — the shape the whole set agrees on — instead of
// smearing outliers into everything. It is computed at the dataset's own native
// frame with every image resampled whole into it, so nothing is cropped out of
// the reference.

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
  REFERENCE_FILE,
  datasetSlug,
  universeUrl,
  type RoboflowDataset,
  type RoboflowRef,
} from "./roboflow"
import { exportFormats, fetchExportLink, fetchProjectInfo } from "./roboflow-api"
import { datasetDir, type ProgressReporter } from "./roboflow-store"

// Must match lib/mosaic.ts SIGNATURE_GRID and the worker's COARSE_GRID: the
// browser compares tiles on 8×8×3 values stored as uint16 LE fixed-point, where
// each stored value is the sum of a 2×2 block of the 16×16 uint8 signature
// (the worker multiplies by 0.25 to recover the mean).
const SIG_GRID = 16
const COARSE_GRID = SIG_GRID >> 1
const COARSE_VALUES = COARSE_GRID * COARSE_GRID * 3

const THUMB_LONG_EDGE = 384
const THUMB_QUALITY = 82
// The median reference is built at the dataset's own native frame (see
// `referenceDims`) so no image has to be cropped into it. The only limit is
// memory: the median histogram costs width × height × 3 × 256 × 2 bytes, so
// ~262k pixels (a 512×512-equivalent frame) is a ~400 MB ceiling. Bigger
// datasets scale down with their aspect ratio preserved.
const MEDIAN_MAX_PIXELS = 262_144
// Used only if not one image in the sample could be read for its dimensions.
const MEDIAN_FALLBACK_EDGE = 384
// Cap on how many images feed the median. Beyond this the sample is strided
// evenly across the (sorted) file list, so it stays deterministic.
const MEDIAN_SAMPLE_MAX = 4000
// Long edge the project cover image is stored at. Matches the mosaic frame in
// lib/mosaic-bake.ts — the engine never draws the reference bigger than this.
const ICON_MAX_EDGE = 1600
const CONCURRENCY = 8

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

// ─── Per-image work ──────────────────────────────────────────────────────────

// Cover-fit `bytes` into w×h and return raw RGB. Transparency is flattened onto
// white and everything is forced to 3-channel sRGB so greyscale and CMYK
// sources produce the same layout as ordinary RGB photos.
async function rawCover(
  bytes: Buffer,
  width: number,
  height: number
): Promise<Buffer> {
  const { data, info } = await sharp(bytes, { failOn: "none" })
    .resize(width, height, { fit: "cover", position: "centre" })
    .flatten({ background: "#ffffff" })
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true })
  if (info.channels !== 3) {
    throw new IngestError(`Unexpected channel count ${info.channels}`)
  }
  return data
}

// Same, but `fit: "fill"` — the WHOLE image is resampled into w×h, so nothing is
// cropped away. Used for the median reference, which must see every image edge
// to edge. The target is the dataset's own native frame (see `referenceDims`),
// so for the usual uniformly-sized export this is a 1:1 map and no resampling
// happens at all; only an image whose aspect differs from the dataset's is
// stretched. The alternative for those would be letterboxing, and padding bars
// would contaminate the median with a colour no image actually contains.
async function rawFill(
  bytes: Buffer,
  width: number,
  height: number
): Promise<Buffer> {
  const { data, info } = await sharp(bytes, { failOn: "none" })
    .resize(width, height, { fit: "fill" })
    .flatten({ background: "#ffffff" })
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true })
  if (info.channels !== 3) {
    throw new IngestError(`Unexpected channel count ${info.channels}`)
  }
  return data
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

// Per-pixel-per-channel value histogram. Accumulating counts lets the median run
// over every sampled image without ever holding them all in memory.
class MedianAccumulator {
  private readonly counts: Uint16Array
  private samples = 0

  constructor(
    readonly width: number,
    readonly height: number
  ) {
    this.counts = new Uint16Array(width * height * 3 * 256)
  }

  add(rgb: Buffer): void {
    const counts = this.counts
    for (let i = 0; i < rgb.length; i++) counts[i * 256 + rgb[i]] += 1
    this.samples += 1
  }

  get count(): number {
    return this.samples
  }

  // The smallest value whose cumulative count reaches ⌊n/2⌋+1 — i.e. the
  // ⌈(n+1)/2⌉-th smallest sample. For an odd n that is exactly the median; for
  // an even n it is the upper of the two middle values rather than their mean,
  // which avoids inventing a value no image contributed and keeps this to one
  // pass over the histogram.
  median(): Buffer {
    if (!this.samples) throw new IngestError("No images contributed to the median.")
    const half = Math.floor(this.samples / 2) + 1
    const values = this.width * this.height * 3
    const out = Buffer.allocUnsafe(values)
    for (let i = 0; i < values; i++) {
      const base = i * 256
      let cumulative = 0
      let value = 255
      for (let v = 0; v < 256; v++) {
        cumulative += this.counts[base + v]
        if (cumulative >= half) {
          value = v
          break
        }
      }
      out[i] = value
    }
    return out
  }
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
  reference: { width: number; height: number; samples: number }
}

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

// The frame the median reference is computed in, from a cheap header-only pass
// over the sample. It is the dataset's OWN native size, so images go in whole
// rather than being cropped to fit: a Roboflow export is normally one uniform
// size, and then this is exactly that size and every image maps 1:1. Mixed-size
// datasets fall back to the median width and height.
//
// The frame is only ever shrunk by the histogram memory ceiling, and that keeps
// the aspect ratio.
async function referenceDims(
  files: string[]
): Promise<{ width: number; height: number }> {
  const widths: number[] = []
  const heights: number[] = []
  const exact = new Map<string, number>()
  await pooled(files.slice(0, 200), CONCURRENCY, async (file) => {
    try {
      const { width, height } = await sharp(file).metadata()
      if (!width || !height) return
      widths.push(width)
      heights.push(height)
      const key = `${width}x${height}`
      exact.set(key, (exact.get(key) ?? 0) + 1)
    } catch {
      // Unreadable images are skipped here and again in the main pass.
    }
  })
  if (!widths.length) {
    return { width: MEDIAN_FALLBACK_EDGE, height: MEDIAN_FALLBACK_EDGE }
  }

  // A size most of the sample shares is the dataset's real frame — use it
  // verbatim rather than a median that could land between two common sizes.
  const [dominantKey, dominantCount] = [...exact.entries()].reduce((a, b) =>
    b[1] > a[1] ? b : a
  )
  let width: number
  let height: number
  if (dominantCount >= widths.length / 2) {
    ;[width, height] = dominantKey.split("x").map(Number)
  } else {
    width = medianOf(widths)
    height = medianOf(heights)
  }

  const pixels = width * height
  if (pixels > MEDIAN_MAX_PIXELS) {
    const scale = Math.sqrt(MEDIAN_MAX_PIXELS / pixels)
    width = Math.max(2, Math.round(width * scale))
    height = Math.max(2, Math.round(height * scale))
  }
  return { width, height }
}

// Deterministic, evenly strided subsample so the median doesn't depend on which
// images happen to come first in the zip.
function medianSample(files: string[]): string[] {
  if (files.length <= MEDIAN_SAMPLE_MAX) return files
  const stride = files.length / MEDIAN_SAMPLE_MAX
  return Array.from(
    { length: MEDIAN_SAMPLE_MAX },
    (_, i) => files[Math.floor(i * stride)]
  )
}

// Build the tile library + median reference from a directory of images and
// write them into `outputDir` in the layout the browser engine expects.
export async function buildLibrary(
  imageFiles: string[],
  outputDir: string,
  report: ProgressReporter
): Promise<LibraryResult> {
  const files = [...imageFiles].sort()
  const thumbsDir = path.join(outputDir, "thumbs")
  await mkdir(thumbsDir, { recursive: true })

  report("Measuring images", 0, files.length)
  const dims = await referenceDims(files)
  const accumulator = new MedianAccumulator(dims.width, dims.height)
  const sample = new Set(medianSample(files))

  const photos: (ManifestPhoto | null)[] = new Array(files.length).fill(null)
  const signatures: (Buffer | null)[] = new Array(files.length).fill(null)
  const seen = new Set<string>()
  let processed = 0
  let skipped = 0

  await pooled(files, CONCURRENCY, async (file, index) => {
    try {
      const bytes = await readFile(file)
      const id = createHash("sha1").update(bytes).digest("hex").slice(0, 16)

      // Duplicate images are common in Roboflow exports (augmented copies land
      // in more than one split). Keep one tile per distinct image.
      if (!seen.has(id)) {
        seen.add(id)
        const metadata = await sharp(bytes, { failOn: "none" }).metadata()
        const sig = await rawCover(bytes, SIG_GRID, SIG_GRID)
        await sharp(bytes, { failOn: "none" })
          .resize(THUMB_LONG_EDGE, THUMB_LONG_EDGE, {
            fit: "inside",
            withoutEnlargement: true,
          })
          .flatten({ background: "#ffffff" })
          .jpeg({ quality: THUMB_QUALITY, mozjpeg: true })
          .toFile(path.join(thumbsDir, `${id}.jpg`))

        photos[index] = {
          id,
          w: metadata.width ?? 0,
          h: metadata.height ?? 0,
          file: path.basename(file),
        }
        signatures[index] = coarseSignature(sig)
      }

      if (sample.has(file)) {
        accumulator.add(await rawFill(bytes, dims.width, dims.height))
      }
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

  report("Computing median reference", 0, 0)
  const medianRgb = accumulator.median()
  await sharp(medianRgb, {
    raw: { width: dims.width, height: dims.height, channels: 3 },
  })
    .jpeg({ quality: 92 })
    .toFile(path.join(outputDir, REFERENCE_FILE))

  report("Writing library", 0, 0)
  await writeFile(
    path.join(outputDir, COARSE_SIGNATURES_FILE),
    Buffer.concat(keptSignatures)
  )
  await writeFile(
    path.join(outputDir, MANIFEST_FILE),
    JSON.stringify(
      { version: new Date().toISOString(), photos: keptPhotos },
      null,
      2
    )
  )

  return {
    photoCount: keptPhotos.length,
    skipped,
    reference: { ...dims, samples: accumulator.count },
  }
}

// ─── Orchestration ───────────────────────────────────────────────────────────

// The project's cover image, saved as the alternative reference. It is whatever
// single image the dataset's author picked to represent the project, so it shows
// one real scene rather than the whole set's consensus.
//
// Capped at the mosaic's own frame size (no crop, aspect preserved) because the
// originals run to several megapixels and the engine never draws the reference
// larger than this. A failure here is not fatal — the median is always there.
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
  // Keep the extracted source images after the library is built. Off by default:
  // the thumbnails are what the mosaic draws, and exports can be gigabytes.
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
  const sourceDir = path.join(outputDir, "source")
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
    const files = await extractImages(zipPath, sourceDir, report)

    let hasIcon = false
    if (resolved.iconUrl) {
      report("Fetching project cover image", 0, 0)
      hasIcon = await downloadIcon(
        resolved.iconUrl,
        path.join(outputDir, ICON_FILE)
      )
    }

    const result = await buildLibrary(files, outputDir, report)

    return {
      ...resolved.ref,
      slug,
      name: resolved.name,
      type: resolved.type,
      imageCount: result.photoCount,
      universeUrl: universeUrl(resolved.ref),
      hasIcon,
    }
  } finally {
    await rm(zipPath, { force: true })
    if (!options.keepSource) await rm(sourceDir, { recursive: true, force: true })
  }
}

// Did this ingest save a project cover image?
export async function hasIconFile(slug: string): Promise<boolean> {
  try {
    await stat(path.join(datasetDir(slug), ICON_FILE))
    return true
  } catch {
    return false
  }
}

// Has this dataset already been ingested? Used to short-circuit a repeat request.
export async function isIngested(slug: string): Promise<boolean> {
  try {
    const dir = datasetDir(slug)
    await stat(path.join(dir, MANIFEST_FILE))
    await stat(path.join(dir, COARSE_SIGNATURES_FILE))
    await stat(path.join(dir, REFERENCE_FILE))
    const thumbs = await readdir(path.join(dir, "thumbs"))
    return thumbs.length > 0
  } catch {
    return false
  }
}
