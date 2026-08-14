// Turns a Roboflow Universe dataset into the mosaic's tile library.
//
// Pipeline:
//   1. resolve the dataset version (cache identity) and page through project
//      search — later pages are requested while the current page's thumbnails
//      download, so search is not stuck on the first 250
//   2. sample up to the tile budget, then fetch each selected thumbnail
//   3. decode each thumbnail into a stable id, 16×16 colour signature, and
//      normalized 192px JPEG, writing the thumb as soon as it is ready
//   4. publish immutable manifest + signature snapshots in batches so the
//      mosaic can open before the whole project has been seeded
//
// Steps 3–4 are shared with the local-directory ingest (scripts/ingest-dir.mts),
// so any folder of images can be mosaicked the same way.
//
// What the mosaic reproduces is chosen in the browser afterwards — the project
// cover, or any single image out of the dataset — so the ingest does not build
// a reference image of its own.

import { createHash } from "node:crypto"
import { readdir, readFile, stat } from "node:fs/promises"
import { availableParallelism } from "node:os"
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
  fetchBinary,
  fetchProjectInfo,
  fetchThumbnail,
  RoboflowApiError,
  searchProjectImages,
  type ProjectImage,
} from "./roboflow-api"
import {
  blobEnabled,
  blobHasDataset,
  blobHasIcon,
  publishLibrarySnapshot,
  readBlobStatus,
} from "./roboflow-blob"
import { blobFileSink, directorySink, type LibrarySink } from "./roboflow-sink"
import {
  IS_VERCEL,
  datasetDir,
  readStatus,
  type ProgressReporter,
} from "./roboflow-store"
import {
  MAX_INDEXED_IMAGES,
  MIN_PARTIAL_TILES,
  PUBLISH_RESERVE_MS,
  SEARCH_PAGE_SIZE,
  SEED_CONCURRENCY,
  SNAPSHOT_BATCH,
  TILE_BUDGET,
  TILE_REQUEST_MS,
  VERCEL_INGEST_DEADLINE_MS,
} from "./roboflow-limits"
import { evenSampleIndices } from "./roboflow-sample"

export { planTileSample } from "./roboflow-sample"
export { VERCEL_INGEST_DEADLINE_MS } from "./roboflow-limits"

// Must match lib/mosaic.ts SIGNATURE_GRID and the worker's COARSE_GRID: the
// browser compares tiles on 8×8×3 values stored as uint16 LE fixed-point, where
// each stored value is the sum of a 2×2 block of the 16×16 uint8 signature
// (the worker multiplies by 0.25 to recover the mean).
const SIG_GRID = 16
const COARSE_GRID = SIG_GRID >> 1
const COARSE_VALUES = COARSE_GRID * COARSE_GRID * 3

// Thumbnails are the only image the browser ever gets. 192px covers all of
// them — the mosaic canvas downsamples to 128, and the hover popup shows
// ~224 CSS px.
const THUMB_LONG_EDGE = 192
const THUMB_QUALITY = 80
// Long edge the project cover image is stored at. Matches the mosaic frame in
// lib/mosaic-bake.ts — the engine never draws the reference bigger than this.
const ICON_MAX_EDGE = 1600
// Local-folder ingest reads full-size files off disk, so that pool follows
// the CPU. API seeding keeps SEED_CONCURRENCY fetches in flight across pages.
const DECODE_CONCURRENCY = Math.max(2, availableParallelism())

export class IngestError extends Error {}

class IngestDeadlineError extends IngestError {}

function assertBeforeDeadline(deadline?: number): void {
  if (deadline && Date.now() >= deadline) {
    throw new IngestDeadlineError(
      "This dataset could not be prepared within the deployment time limit. Try again — a second run continues from the images already published."
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

function isDeadlineError(error: unknown): boolean {
  if (error instanceof IngestDeadlineError || isTimeoutError(error)) return true
  return error instanceof RoboflowApiError && /timed out/i.test(error.message)
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
export async function decodeOutputs(bytes: Buffer): Promise<{
  width: number
  height: number
  signature: Buffer
  thumbnail: Buffer
}> {
  const image = sharp(bytes, { failOn: "none" })
  const [metadata, signature, thumbnail] = await Promise.all([
    image.metadata(),
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
export async function pooled<T>(
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

// Same bound as `pooled`, but items can arrive while workers are already
// running, so a later search page does not wait for the current one to drain.
function livePool<T>(
  limit: number,
  task: (item: T) => Promise<void>
): {
  push: (item: T) => void
  end: () => Promise<void>
} {
  const queue: T[] = []
  const waiters: Array<() => void> = []
  let ended = false
  let failure: unknown = null

  const notify = () => {
    while (waiters.length) waiters.pop()?.()
  }

  const take = async (): Promise<T | undefined> => {
    for (;;) {
      if (failure) return undefined
      const item = queue.shift()
      if (item) return item
      if (ended) return undefined
      await new Promise<void>((resolve) => {
        waiters.push(resolve)
      })
    }
  }

  const workers = Array.from({ length: Math.max(1, limit) }, async () => {
    for (;;) {
      const item = await take()
      if (!item) return
      try {
        await task(item)
      } catch (error) {
        failure ??= error
        ended = true
        notify()
        return
      }
    }
  })

  return {
    push(item) {
      if (ended || failure) return
      queue.push(item)
      notify()
    },
    async end() {
      ended = true
      notify()
      await Promise.all(workers)
      if (failure) throw failure
    },
  }
}

export type ManifestPhoto = { id: string; w: number; h: number; file: string }
export type LibraryResult = {
  photoCount: number
  skipped: number
  // Manifest version this build stamped. The browser keys its cached copy of
  // the library on it, so a re-ingest invalidates that copy without a fetch.
  version: string
}

export type LibrarySnapshotResult = LibraryResult & {
  manifest: Buffer
  signatures: Buffer
}

// ─── Building a library into a sink ──────────────────────────────────────────

// Turns image bytes into tiles and hands each thumbnail to the sink as it is
// built. Nothing accumulates here except the manifest rows and their
// signatures — 200 bytes or so per tile.
type TileBuilder = {
  // Turn one source image into a tile. Never throws for a bad image: a dataset
  // with one unreadable file still mosaics.
  add: (
    name: string,
    bytes: Buffer,
    options?: { id?: string }
  ) => Promise<boolean>
  // Note an image that could not be read at all, so progress stays honest.
  drop: () => void
  readonly count: number
  readonly processed: number
  readonly skipped: number
  readonly full: boolean
  setTotal: (total: number) => void
  // Current manifest + signatures, without requiring the run to be finished.
  snapshot: () => LibrarySnapshotResult
}

function tileBuilder(
  sink: LibrarySink,
  report: ProgressReporter,
  options: { budget: number }
): TileBuilder {
  const kept = new Map<string, { photo: ManifestPhoto; signature: Buffer }>()
  const seen = new Set<string>()
  let processed = 0
  let skipped = 0
  let total = 0

  const tick = () => {
    processed += 1
    report("Seeding tiles", processed, total)
  }

  const serialize = (): LibrarySnapshotResult => {
    if (!kept.size) {
      throw new IngestError("None of the dataset's images could be read.")
    }
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
    return {
      version,
      manifest,
      signatures: Buffer.concat(signatures),
      photoCount: photos.length,
      skipped,
    }
  }

  return {
    add: async (name, bytes, addOptions) => {
      try {
        const id =
          addOptions?.id ??
          createHash("sha1").update(bytes).digest("hex").slice(0, 16)
        if (seen.has(id)) return false
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
        return true
      } catch {
        skipped += 1
        return false
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
    snapshot: serialize,
  }
}

function tileIdFor(imageId: string): string {
  return createHash("sha1").update(imageId).digest("hex").slice(0, 16)
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

  await pooled(files, DECODE_CONCURRENCY, async (file) => {
    assertBeforeDeadline(limits.deadline)
    if (builder.full) return
    await builder.add(file, await readFile(file))
  })

  const built = builder.snapshot()
  await publishLibrarySnapshot(path.basename(outputDir), built, {
    directory: outputDir,
  })
  await sink.finish()
  return { photoCount: builder.count, skipped: builder.skipped, version: built.version }
}

export type ImageBuild = LibrarySnapshotResult & {
  sourceImages: number
  sampled: boolean
}

export async function buildLibraryFromImages(
  ref: RoboflowRef,
  images: ProjectImage[],
  sink: LibrarySink,
  report: ProgressReporter,
  options: {
    budget?: number
    deadline?: number
    sourceImages?: number
    slug?: string
    directory?: string
    onSnapshot?: (built: ImageBuild) => Promise<void> | void
  } = {}
): Promise<ImageBuild> {
  const budget = options.budget ?? TILE_BUDGET
  const readDeadline = options.deadline
    ? options.deadline - PUBLISH_RESERVE_MS
    : undefined
  const sourceImages = options.sourceImages ?? images.length
  const builder = tileBuilder(sink, report, { budget })
  builder.setTotal(images.length)
  report("Seeding tiles", 0, images.length)

  let lastPublished = 0
  let lastBuilt: ImageBuild | undefined
  let snapshotting = Promise.resolve()
  const publish = async (force: boolean) => {
    if (!builder.count) return
    const due =
      force ||
      (lastPublished === 0 && builder.count >= MIN_PARTIAL_TILES) ||
      (lastPublished > 0 && builder.count - lastPublished >= SNAPSHOT_BATCH)
    if (!due) return
    const built: ImageBuild = {
      ...builder.snapshot(),
      sourceImages,
      sampled: sourceImages > builder.count,
    }
    if (options.slug || options.directory) {
      await publishLibrarySnapshot(options.slug ?? "local--dataset--v1", built, {
        abortSignal: deadlineSignal(options.deadline),
        directory: options.directory,
      })
    }
    lastPublished = built.photoCount
    lastBuilt = built
    await options.onSnapshot?.(built)
  }
  const queuePublish = (force: boolean) => {
    snapshotting = snapshotting.then(
      () => publish(force),
      () => publish(force)
    )
    return snapshotting
  }

  const stop = () =>
    builder.full || Boolean(readDeadline && Date.now() >= readDeadline)

  try {
    await pooled(images, SEED_CONCURRENCY, async (image) => {
      if (stop()) return
      const item = await fetchThumbnail(ref, image, {
        signal: deadlineSignal(readDeadline),
      })
      if (stop()) return
      if (!item.bytes) {
        builder.drop()
        return
      }
      await builder.add(item.image.name ?? item.image.id, item.bytes, {
        id: tileIdFor(item.image.id),
      })
      queuePublish(false)
    })
  } catch (error) {
    if (!isDeadlineError(error) || builder.count < MIN_PARTIAL_TILES) throw error
  }

  await queuePublish(true)
  if (!lastBuilt || !builder.count) {
    assertBeforeDeadline(readDeadline)
    throw new IngestError("None of the dataset's images could be read.")
  }
  return {
    ...lastBuilt,
    sampled:
      lastBuilt.sampled ||
      lastBuilt.sourceImages > lastBuilt.photoCount ||
      builder.processed < images.length,
  }
}

export async function buildLibraryFromSearch(
  ref: RoboflowRef,
  sink: LibrarySink,
  report: ProgressReporter,
  options: {
    budget?: number
    deadline?: number
    slug?: string
    directory?: string
    onSnapshot?: (built: ImageBuild) => Promise<void> | void
  } = {}
): Promise<ImageBuild> {
  const budget = options.budget ?? TILE_BUDGET
  const readDeadline = options.deadline
    ? options.deadline - PUBLISH_RESERVE_MS
    : undefined
  const builder = tileBuilder(sink, report, { budget })
  report("Searching images", 0, 0)

  let lastPublished = 0
  let lastBuilt: ImageBuild | undefined
  let snapshotting = Promise.resolve()
  let sourceImages = 0
  const publish = async (force: boolean) => {
    if (!builder.count) return
    const due =
      force ||
      (lastPublished === 0 && builder.count >= MIN_PARTIAL_TILES) ||
      (lastPublished > 0 && builder.count - lastPublished >= SNAPSHOT_BATCH)
    if (!due) return
    const built: ImageBuild = {
      ...builder.snapshot(),
      sourceImages,
      sampled: sourceImages > builder.count,
    }
    if (options.slug || options.directory) {
      await publishLibrarySnapshot(options.slug ?? "local--dataset--v1", built, {
        abortSignal: deadlineSignal(options.deadline),
        directory: options.directory,
      })
    }
    lastPublished = built.photoCount
    lastBuilt = built
    await options.onSnapshot?.(built)
  }
  const queuePublish = (force: boolean) => {
    snapshotting = snapshotting.then(
      () => publish(force),
      () => publish(force)
    )
    return snapshotting
  }

  const stop = () =>
    builder.full || Boolean(readDeadline && Date.now() >= readDeadline)

  const cancelSearch = new AbortController()
  const searchSignal = () => {
    const deadline = deadlineSignal(readDeadline)
    return deadline
      ? AbortSignal.any([cancelSearch.signal, deadline])
      : cancelSearch.signal
  }

  const seeding = livePool(SEED_CONCURRENCY, async (image: ProjectImage) => {
    if (stop()) {
      cancelSearch.abort()
      return
    }
    const item = await fetchThumbnail(ref, image, {
      signal: deadlineSignal(readDeadline),
    })
    if (stop()) {
      cancelSearch.abort()
      return
    }
    if (!item.bytes) {
      builder.drop()
      return
    }
    await builder.add(item.image.name ?? item.image.id, item.bytes, {
      id: tileIdFor(item.image.id),
    })
    queuePublish(false)
  })

  try {
    let index = 0
    let offset = 0
    let wanted: Set<number> | null = null

    for (;;) {
      assertBeforeDeadline(readDeadline)
      if (stop()) break
      const page = await searchProjectImages(ref, {
        offset,
        limit: SEARCH_PAGE_SIZE,
        signal: searchSignal(),
      })
      sourceImages = Math.max(page.total, sourceImages)
      if (!page.results.length) break

      if (!wanted) {
        const total = Math.max(page.total, page.results.length)
        const affordable =
          readDeadline !== undefined
            ? Math.max(
                1,
                Math.floor(Math.max(0, readDeadline - Date.now()) / TILE_REQUEST_MS)
              )
            : budget
        const take = Math.min(budget, MAX_INDEXED_IMAGES, total, affordable)
        wanted = evenSampleIndices(total, take)
        builder.setTotal(wanted.size)
      }

      for (const image of page.results) {
        if (wanted.has(index++)) seeding.push(image)
      }
      if (builder.processed === 0) {
        report(
          "Searching images",
          Math.min(index, page.total || index),
          page.total
        )
      }

      offset += page.results.length
      if (
        page.total > 0
          ? offset >= page.total
          : page.results.length < SEARCH_PAGE_SIZE
      ) {
        break
      }
    }

    await seeding.end()
  } catch (error) {
    cancelSearch.abort()
    await seeding.end().catch(() => undefined)
    if (!isDeadlineError(error) || builder.count < MIN_PARTIAL_TILES) throw error
  }

  await queuePublish(true)
  if (!lastBuilt || !builder.count) {
    assertBeforeDeadline(readDeadline)
    throw new IngestError(
      sourceImages
        ? "None of the dataset's images could be read."
        : "The project contained no images."
    )
  }
  return {
    ...lastBuilt,
    sampled:
      lastBuilt.sampled ||
      lastBuilt.sourceImages > lastBuilt.photoCount ||
      builder.full,
  }
}

// ─── Orchestration ───────────────────────────────────────────────────────────

// The project's cover image — whatever single image the dataset's author picked
// to represent it, and the default thing the mosaic reproduces.
async function downloadIcon(
  url: string,
  deadline?: number
): Promise<Buffer | null> {
  try {
    const remaining = deadline ? deadline - Date.now() : 10_000
    const bytes = await fetchBinary(url, {
      signal: AbortSignal.timeout(Math.max(1, Math.min(10_000, remaining))),
    })
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
  // Roboflow keeps versions whose generation never produced anything; they
  // report zero images. Reaching one means it was asked for by name, or that
  // the project has no other kind — either way, saying so beats failing later.
  if (info.imagesByVersion.get(version) === 0) {
    const usable = info.versions.filter(
      (n) => info.imagesByVersion.get(n) !== 0
    )
    throw new IngestError(
      usable.length
        ? `Version ${version} of ${info.name} contains no images. Versions with images: ${usable.join(", ")}.`
        : `${info.name} has no version containing images yet.`
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
  onSnapshot?: (dataset: RoboflowDataset) => Promise<void> | void
}

function datasetRecord(
  resolved: ResolvedDataset,
  slug: string,
  built: ImageBuild,
  hasIcon: boolean
): RoboflowDataset {
  return {
    ...resolved.ref,
    slug,
    name: resolved.name,
    type: resolved.type,
    imageCount: built.photoCount,
    sourceImages: built.sampled
      ? Math.max(built.sourceImages, resolved.images)
      : undefined,
    universeUrl: universeUrl(resolved.ref),
    hasIcon,
    libraryVersion: built.version,
  }
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
  const budget = options.budget ?? TILE_BUDGET

  const publishing = blobEnabled()
  const sink = publishing
    ? await blobFileSink(slug, { abortSignal: deadlineSignal(deadline) })
    : await directorySink(datasetDir(slug))

  let lastDataset: RoboflowDataset | undefined
  try {
    let hasIcon = false
    if (resolved.iconUrl) {
      report("Fetching project cover image", 0, 0)
      const icon = await downloadIcon(resolved.iconUrl, deadline)
      if (icon) {
        await sink.add(ICON_FILE, icon)
        hasIcon = true
      }
    }

    const built = await buildLibraryFromSearch(
      resolved.ref,
      sink,
      report,
      {
        budget,
        deadline,
        slug,
        directory: publishing ? undefined : datasetDir(slug),
        onSnapshot: async (snapshot) => {
          lastDataset = datasetRecord(resolved, slug, snapshot, hasIcon)
          await options.onSnapshot?.(lastDataset)
        },
      }
    )

    report("Publishing library", 0, 0)
    await sink.finish()
    const dataset = datasetRecord(resolved, slug, built, hasIcon)
    lastDataset = dataset
    await options.onSnapshot?.(dataset)
    return dataset
  } catch (error) {
    await sink.abort().catch(() => undefined)
    if (lastDataset && isDeadlineError(error) && lastDataset.imageCount >= MIN_PARTIAL_TILES) {
      return lastDataset
    }
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
// empty — that is the whole point of publishing it. A snapshot written while
// the job is still running does not count: another caller should join that
// job rather than treat the library as finished.
export async function isIngested(slug: string): Promise<boolean> {
  const status = blobEnabled()
    ? await readBlobStatus(slug)
    : await readStatus(slug)
  if (status?.state === "running") return false
  if (status?.state === "ready") return true
  if (await isIngestedLocally(slug)) return true
  return blobEnabled() ? blobHasDataset(slug) : false
}
