// Turns a Roboflow Universe dataset into the mosaic's tile library.
//
// Pipeline:
//   1. resolve the dataset version and ask Roboflow for a zip export link
//   2. read the export's index (its central directory) over HTTP and choose
//      which image entries this deployment can afford to build tiles from
//   3. pull those entries straight out of the remote zip — one decode per image →
//      content-addressed id, 16×16 colour signature, and a thumbnail
//   4. write manifest.json + signatures-coarse.bin + thumbs/ into a sink
//
// Nothing along that path is staged on disk. The export is never spooled, the
// thumbnails are never written on a serverless host: they are zipped and pushed
// to Blob as they are produced (lib/roboflow-sink.ts). That is deliberate —
// `/tmp` is ~500 MB, datasets are not, and the size of the dataset should not
// decide whether the site works.
//
// Steps 3–4 are shared with the local-directory ingest (scripts/ingest-dir.mts),
// so any folder of images can be mosaicked the same way.
//
// What the mosaic reproduces is chosen in the browser afterwards — the project
// cover, or any single image out of the dataset — so the ingest does not build a
// reference image of its own.
//
// Everything written here ends up in one zip that the browser downloads whole
// (lib/roboflow-pack.ts), which is why the thumbnails are sized for the client
// rather than for an image CDN.

import { createHash } from "node:crypto"
import { readdir, readFile, stat } from "node:fs/promises"
import path from "node:path"

import sharp from "sharp"

import {
  COARSE_SIGNATURES_FILE,
  ICON_FILE,
  MANIFEST_FILE,
  datasetSlug,
  roboflowThumbPath,
  universeUrl,
  type RoboflowDataset,
  type RoboflowRef,
} from "./roboflow"
import {
  exportFormats,
  fetchExportLink,
  fetchProjectInfo,
} from "./roboflow-api"
import { blobEnabled, blobHasDataset, blobHasIcon } from "./roboflow-blob"
import {
  blobArchiveSink,
  directorySink,
  publishManifest,
  type LibrarySink,
} from "./roboflow-sink"
import { IS_VERCEL, datasetDir, type ProgressReporter } from "./roboflow-store"
import {
  MAX_EXPORT_WAIT_MS,
  MAX_INDEXED_IMAGES,
  MIN_PARTIAL_TILES,
  PUBLISH_RESERVE_MS,
  TILE_BUDGET,
  TILE_DECODE_MS,
  TILE_FETCH_BYTES_PER_MS,
  VERCEL_INGEST_DEADLINE_MS,
} from "./roboflow-limits"
import {
  readZipEntries,
  readZipIndex,
  streamZipEntries,
  type ZipEntry,
  type ZipIndex,
} from "./roboflow-zip"

export { VERCEL_INGEST_DEADLINE_MS } from "./roboflow-limits"

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
// Ranged reads of the export overlap the network with the decode, so a serverless
// function can keep more in flight than it has cores. A local machine reading
// files off its own disk is purely CPU-bound.
const READ_CONCURRENCY = IS_VERCEL ? 6 : 8
// A sequential read is one connection, so extra slots only queue decodes.
const STREAM_CONCURRENCY = IS_VERCEL ? 3 : 8

export class IngestError extends Error {}

class IngestDeadlineError extends IngestError {}

function assertBeforeDeadline(deadline?: number): void {
  if (deadline && Date.now() >= deadline) {
    throw new IngestDeadlineError(
      "This dataset could not be prepared within the deployment time limit. Try again — a second run reuses the export Roboflow has already generated."
    )
  }
}

function deadlineSignal(deadline?: number): AbortSignal | undefined {
  if (!deadline) return undefined
  assertBeforeDeadline(deadline)
  return AbortSignal.timeout(Math.max(1, deadline - Date.now()))
}

function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  )
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
async function decodeOutputs(bytes: Buffer): Promise<{
  width: number
  height: number
  signature: Buffer
  thumbnail: Buffer
}> {
  const image = sharp(bytes, { failOn: "none" })
  const metadata = await image.metadata()

  const [signature, thumbnail] = await Promise.all([
    signatureGrid(image.clone()).then(coarseSignature),
    image
      .clone()
      .resize(THUMB_LONG_EDGE, THUMB_LONG_EDGE, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: THUMB_QUALITY })
      .toBuffer(),
  ])

  return {
    width: metadata.width ?? 0,
    height: metadata.height ?? 0,
    signature,
    thumbnail,
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
  let failure: unknown = null
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (!failure) {
        const index = next++
        if (index >= items.length) return
        try {
          await task(items[index], index)
        } catch (error) {
          failure ??= error
        }
      }
    }
  )
  await Promise.all(workers)
  if (failure) throw failure
}

export type ManifestPhoto = { id: string; w: number; h: number; file: string }
export type LibraryResult = {
  photoCount: number
  skipped: number
  // Manifest version this build stamped. The browser keys its cached copy of
  // the library on it, so a re-ingest invalidates that copy without a fetch.
  version: string
}

// ─── Building a library into a sink ──────────────────────────────────────────

// Turns image bytes into tiles and hands each one to the sink as it is built.
// Nothing accumulates here except the manifest rows and their signatures — 200
// bytes or so per tile, which is why the ceiling on tiles is about what the
// mosaic can draw rather than what the host can hold.
type TileBuilder = {
  // Turn one source image into a tile. Never throws for a bad image: a dataset
  // with one unreadable file still mosaics.
  add: (name: string, bytes: Buffer) => Promise<void>
  // Note an image that could not be read at all, so progress stays honest.
  drop: () => void
  readonly count: number
  readonly processed: number
  readonly skipped: number
  readonly full: boolean
  setTotal: (total: number) => void
  // Write manifest.json and signatures-coarse.bin, closing the library out.
  write: () => Promise<{ version: string; manifest: Buffer }>
}

function tileBuilder(
  sink: LibrarySink,
  report: ProgressReporter,
  options: { budget: number }
): TileBuilder {
  // Keyed by source name so the manifest can be ordered independently of the
  // order the reader happened to produce entries in.
  const kept = new Map<string, { photo: ManifestPhoto; signature: Buffer }>()
  const seen = new Set<string>()
  let processed = 0
  let skipped = 0
  let total = 0

  const tick = () => {
    processed += 1
    report("Building tiles", processed, total)
  }

  return {
    add: async (name, bytes) => {
      try {
        const id = createHash("sha1").update(bytes).digest("hex").slice(0, 16)
        // Roboflow exports the same image into several splits, and augmented
        // copies alongside it; a byte-identical duplicate already has a tile.
        if (seen.has(id)) return
        seen.add(id)

        const decoded = await decodeOutputs(bytes)
        await sink.add(roboflowThumbPath(id), decoded.thumbnail)
        kept.set(name, {
          photo: {
            id,
            w: decoded.width,
            h: decoded.height,
            file: path.basename(name),
          },
          signature: decoded.signature,
        })
      } catch {
        skipped += 1
      } finally {
        tick()
      }
    },
    drop: () => {
      skipped += 1
      tick()
    },
    get count() {
      return kept.size
    },
    get processed() {
      return processed
    },
    get skipped() {
      return skipped
    },
    get full() {
      return kept.size >= options.budget
    },
    setTotal: (value) => {
      total = value
    },
    write: async () => {
      if (!kept.size) {
        throw new IngestError("None of the dataset's images could be read.")
      }
      report("Writing library", 0, 0)
      const version = new Date().toISOString()
      const photos: ManifestPhoto[] = []
      const signatures: Buffer[] = []
      for (const name of [...kept.keys()].sort()) {
        const entry = kept.get(name)
        if (!entry) continue
        photos.push(entry.photo)
        signatures.push(entry.signature)
      }
      const manifest = Buffer.from(JSON.stringify({ version, photos }))
      await sink.add(COARSE_SIGNATURES_FILE, Buffer.concat(signatures))
      await sink.add(MANIFEST_FILE, manifest)
      return { version, manifest }
    },
  }
}

// Build the tile library from a directory of images and write it into
// `outputDir` in the layout the browser engine expects.
export async function buildLibrary(
  imageFiles: string[],
  outputDir: string,
  report: ProgressReporter,
  limits: { deadline?: number } = {}
): Promise<LibraryResult> {
  const files = [...imageFiles].sort()
  const sink = await directorySink(outputDir)
  const builder = tileBuilder(sink, report, { budget: TILE_BUDGET })
  builder.setTotal(files.length)

  await pooled(files, READ_CONCURRENCY, async (file) => {
    assertBeforeDeadline(limits.deadline)
    if (builder.full) return
    await builder.add(file, await readFile(file))
  })

  const { version } = await builder.write()
  await sink.finish()
  return { photoCount: builder.count, skipped: builder.skipped, version }
}

// ─── Choosing what to build tiles from ───────────────────────────────────────

// How many tiles this run can afford, and which entries they come from.
//
// A dataset with more images than the tile budget is sampled across the whole
// set rather than cut off partway, so the mosaic still draws from all of it. When
// there is a deadline, the sample also shrinks to what can plausibly be fetched
// and decoded before it — a 40 GB export cannot be read in five minutes at any
// tile size, and a mosaic of 8,000 tiles out of it beats an error message.
export function planTileSample(
  index: ZipIndex,
  options: { budget: number; msAvailable?: number }
): ZipEntry[] {
  const entries = index.entries
  if (!entries.length) return []

  let count = Math.min(entries.length, options.budget)
  if (options.msAvailable !== undefined) {
    let bytes = 0
    for (const entry of entries) bytes += entry.compressedSize
    const averageBytes = bytes / entries.length
    const msPerTile = averageBytes / TILE_FETCH_BYTES_PER_MS + TILE_DECODE_MS
    const affordable = Math.floor(Math.max(0, options.msAvailable) / msPerTile)
    count = Math.max(1, Math.min(count, affordable))
  }
  if (count >= entries.length) return entries

  // Even stride across the index, which is itself an even sample of the export.
  const sampled: ZipEntry[] = new Array(count)
  for (let i = 0; i < count; i++) {
    sampled[i] = entries[Math.floor((i * entries.length) / count)]
  }
  return sampled
}

type CollectResult = {
  // Image entries the export holds, as far as the reader could tell.
  sourceImages: number
  // The library is a subset of the export: more images than the mosaic can use,
  // or more than this run had time for.
  sampled: boolean
}

async function collectTiles(
  link: string,
  builder: TileBuilder,
  report: ProgressReporter,
  options: { deadline?: number; budget: number }
): Promise<CollectResult> {
  // Everything up to here is interruptible; the reserve is what publishes the
  // library that has been built, so reads never run into the hard deadline.
  const readDeadline = options.deadline
    ? options.deadline - PUBLISH_RESERVE_MS
    : undefined
  assertBeforeDeadline(readDeadline)
  const stop = () =>
    builder.full || Boolean(readDeadline && Date.now() >= readDeadline)

  report("Reading export index", 0, 0)
  const index = await readZipIndex(link, {
    maxEntries: MAX_INDEXED_IMAGES,
    signal: deadlineSignal(readDeadline),
  })

  const finished = (sampled: boolean, sourceImages: number): CollectResult => {
    if (builder.count) return { sourceImages, sampled }
    // Nothing usable came back, so whatever stopped the read is the failure.
    assertBeforeDeadline(readDeadline)
    throw new IngestError("None of the dataset's images could be read.")
  }

  const enough = () => builder.count >= MIN_PARTIAL_TILES

  if (index) {
    const plan = planTileSample(index, {
      budget: options.budget,
      msAvailable: readDeadline ? readDeadline - Date.now() : undefined,
    })
    if (!plan.length) {
      throw new IngestError("The dataset export contained no images.")
    }
    builder.setTotal(plan.length)
    report("Building tiles", 0, plan.length)
    try {
      await readZipEntries(
        link,
        plan,
        (entry, bytes) => builder.add(entry.name, bytes),
        {
          concurrency: READ_CONCURRENCY,
          signal: deadlineSignal(readDeadline),
          stop,
          // One unreadable entry in a 20,000-image export is not a failed
          // ingest; it is a tile the mosaic does without.
          onEntryError: () => builder.drop(),
        }
      )
    } catch (error) {
      // A read that ran out of time still leaves a usable library behind.
      if (!isTimeoutError(error) || !enough()) throw error
      return finished(true, index.imageCount)
    }
    return finished(
      plan.length < index.imageCount || builder.processed < plan.length,
      index.imageCount
    )
  }

  // No index: the host will not serve ranges, so the export can only be read in
  // order. Every entry costs its bytes whether or not it becomes a tile, so this
  // takes images until the budget is met and then stops the download rather than
  // striding across a dataset it would have to read all of anyway.
  let images = 0
  // Counted as entries are accepted rather than as tiles land: a decode takes
  // long enough that `builder.count` would still read zero after a hundred
  // small entries have gone past.
  let taken = 0
  builder.setTotal(options.budget)
  report("Building tiles", 0, options.budget)
  try {
    await streamZipEntries(
      link,
      (entry, bytes) => builder.add(entry.name, bytes),
      {
        want: () => {
          images += 1
          if (taken >= options.budget) return false
          taken += 1
          return true
        },
        concurrency: STREAM_CONCURRENCY,
        signal: deadlineSignal(readDeadline),
        stop: () => taken >= options.budget || stop(),
      }
    )
  } catch (error) {
    if (!isTimeoutError(error) || !enough()) throw error
    return finished(true, images)
  }
  return finished(taken >= options.budget, images)
}

export type ExportBuild = LibraryResult & {
  // Images the export holds, whether or not each became a tile.
  sourceImages: number
  // The library is an even sample of the export rather than all of it.
  sampled: boolean
  // manifest.json, so a caller that publishes can do so without rereading it.
  manifest: Buffer
}

// Build a whole tile library out of a remote export zip, writing it into `sink`
// as it goes. The export is never held anywhere: entries are read from the
// remote zip, turned into tiles, and handed straight on.
export async function buildLibraryFromExport(
  link: string,
  sink: LibrarySink,
  report: ProgressReporter,
  options: { budget?: number; deadline?: number } = {}
): Promise<ExportBuild> {
  const budget = options.budget ?? TILE_BUDGET
  const builder = tileBuilder(sink, report, { budget })
  const collected = await collectTiles(link, builder, report, {
    deadline: options.deadline,
    budget,
  })
  const { version, manifest } = await builder.write()
  return {
    version,
    manifest,
    photoCount: builder.count,
    skipped: builder.skipped,
    sourceImages: Math.max(collected.sourceImages, builder.count),
    sampled: collected.sampled,
  }
}

// ─── Orchestration ───────────────────────────────────────────────────────────

// The project's cover image — whatever single image the dataset's author picked
// to represent it, and the default thing the mosaic reproduces.
//
// Capped at the mosaic's own frame size (no crop, aspect preserved) because the
// originals run to several megapixels and the engine never draws the reference
// larger than this. A failure here is not fatal: the picker can still offer any
// image out of the dataset.
async function downloadIcon(
  url: string,
  deadline?: number
): Promise<Buffer | null> {
  try {
    const remaining = deadline ? deadline - Date.now() : 10_000
    const response = await fetch(url, {
      signal: AbortSignal.timeout(Math.max(1, Math.min(10_000, remaining))),
    })
    if (!response.ok) return null
    const bytes = Buffer.from(await response.arrayBuffer())
    return await sharp(bytes, { failOn: "none" })
      .rotate() // honour EXIF orientation before the dimensions are baked in
      .resize(ICON_MAX_EDGE, ICON_MAX_EDGE, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 92 })
      .toBuffer()
  } catch {
    return null
  }
}

export type ResolvedDataset = {
  ref: RoboflowRef & { version: number }
  name: string
  type?: string
  images: number
  iconUrl?: string
}

export async function resolveDataset(
  ref: RoboflowRef
): Promise<ResolvedDataset> {
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
  // The route already resolves this to check the cache and the limits. Supplying
  // it avoids a second Roboflow project-info request inside the background job.
  resolved?: ResolvedDataset
  deadline?: number
  // Tiles to build at most. Defaults to the deployment's budget.
  budget?: number
}

export async function ingestDataset(
  ref: RoboflowRef,
  report: ProgressReporter,
  options: IngestOptions = {}
): Promise<RoboflowDataset> {
  if (IS_VERCEL && !blobEnabled()) {
    throw new IngestError(
      "Dataset storage is not configured. Connect a Vercel Blob store and redeploy."
    )
  }
  report("Resolving dataset", 0, 0)
  const resolved = options.resolved ?? (await resolveDataset(ref))
  const deadline =
    options.deadline ??
    (IS_VERCEL ? Date.now() + VERCEL_INGEST_DEADLINE_MS : undefined)
  assertBeforeDeadline(deadline)
  const slug = datasetSlug(resolved.ref)

  report("Requesting export", 0, 0)
  const exportWait = deadline
    ? Math.min(MAX_EXPORT_WAIT_MS, Math.max(1, deadline - Date.now() - 120_000))
    : undefined
  const { link } = await fetchExportLink(
    resolved.ref,
    exportFormats(resolved.type),
    (message) => report(message, 0, 0),
    exportWait
  )
  assertBeforeDeadline(deadline)

  const publishing = blobEnabled()
  const sink = publishing
    ? await blobArchiveSink(slug, { abortSignal: deadlineSignal(deadline) })
    : await directorySink(datasetDir(slug))

  try {
    // The cover goes in first so a run that stops early still has one.
    let hasIcon = false
    if (resolved.iconUrl) {
      report("Fetching project cover image", 0, 0)
      const icon = await downloadIcon(resolved.iconUrl, deadline)
      if (icon) {
        await sink.add(ICON_FILE, icon)
        hasIcon = true
      }
    }

    const built = await buildLibraryFromExport(link, sink, report, {
      budget: options.budget,
      deadline,
    })

    report("Publishing library", 0, 0)
    await sink.finish()
    if (publishing) {
      await publishManifest(slug, built.manifest, deadlineSignal(deadline))
    }

    return {
      ...resolved.ref,
      slug,
      name: resolved.name,
      type: resolved.type,
      imageCount: built.photoCount,
      // Only set when the library really is a subset, so the page can say so.
      sourceImages: built.sampled
        ? Math.max(built.sourceImages, resolved.images)
        : undefined,
      universeUrl: universeUrl(resolved.ref),
      hasIcon,
      libraryVersion: built.version,
    }
  } catch (error) {
    await sink.abort().catch(() => undefined)
    throw error
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
