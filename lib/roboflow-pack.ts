// The browser's handle on an ingested dataset.
//
// Only two files are actually downloaded: the manifest (every photo's id and
// dimensions) and the coarse signature blob the worker matches against. Those
// are all a mosaic needs to decide which photo goes in which cell, and together
// they are a small fraction of the library.
//
// Thumbnails are not downloaded here at all. A mosaic paints far fewer tiles
// than a large dataset contains, and the reference grid shows a page at a time,
// so `thumbUrl` hands back a URL into the asset route and the image is fetched
// only when something actually draws it. The bytes for an unused photo are
// never transferred.
//
// Both files are requested with the library version on the URL and served
// immutably, so a reload is an HTTP cache hit rather than a second download.

import {
  COARSE_SIGNATURES_FILE,
  ICON_FILE,
  MANIFEST_FILE,
  roboflowAssetUrl,
  roboflowThumbPath,
} from "./roboflow"
import { MIB } from "./roboflow-limits"
import { COARSE_SIG_BYTES } from "./tile-library"

export type PackProgress = {
  // Bytes received so far, and the total when the server declared one.
  loaded: number
  total: number
  step: "downloading" | "preparing"
}

export type RoboflowPack = {
  slug: string
  version: string
  manifest: PackManifest
  signatures: Uint8Array
  // The project's cover, when the ingest saved one.
  iconUrl: string | null
  // Where to fetch a tile. Nothing is downloaded until a caller uses it.
  thumbUrl: (id: string) => string | null
  release: () => void
}

export type PackManifest = {
  version: string
  photos: { id: string; w: number; h: number; file?: string }[]
}

// The manifest and the signature blob are buffered whole, so a corrupt or
// hostile response could otherwise make the tab allocate without bound. Both
// scale linearly with the photo count the ingest published, so their ceilings
// are derived from it with headroom rather than fixed — a fixed ceiling is a
// limit on dataset size in disguise, and eventually a real dataset crosses it.
//
// Thumbnails need no such guard now: each one is its own response, decoded by
// the image pipeline rather than buffered here.

// Padded well above the ~150 bytes/photo a real manifest weighs, so long image
// filenames never trip it.
const MANIFEST_BYTES_PER_PHOTO = 256
const MANIFEST_OVERHEAD_BYTES = 64 * 1024
// Signatures are exactly `COARSE_SIG_BYTES` per photo; the overhead is slack.
const SIGNATURE_OVERHEAD_BYTES = 64 * 1024
// A hostile response has to more than double the expected size to be rejected,
// which keeps buffered memory bounded to ~2x what the dataset legitimately needs
// while tolerating any reasonable drift between the reported and packed counts.
const ENTRY_SIZE_SAFETY_MULTIPLE = 2
const PHOTO_COUNT_SAFETY_MULTIPLE = 2

// Last-resort ceilings for when the expected count is unknown, so a missing
// count can never let a response or the photo list grow unbounded.
const ABSOLUTE_MAX_ENTRY_BYTES = 1024 * MIB
const ABSOLUTE_MAX_PHOTOS = 5_000_000

function scaledLimit(
  perPhoto: number,
  overhead: number,
  expectedPhotoCount?: number | null
): number {
  if (!expectedPhotoCount || expectedPhotoCount <= 0) {
    return ABSOLUTE_MAX_ENTRY_BYTES
  }
  const scaled =
    overhead + expectedPhotoCount * perPhoto * ENTRY_SIZE_SAFETY_MULTIPLE
  return Math.min(ABSOLUTE_MAX_ENTRY_BYTES, scaled)
}

function maxPhotoCount(expectedPhotoCount?: number | null): number {
  if (!expectedPhotoCount || expectedPhotoCount <= 0) return ABSOLUTE_MAX_PHOTOS
  return Math.min(
    ABSOLUTE_MAX_PHOTOS,
    Math.ceil(expectedPhotoCount * PHOTO_COUNT_SAFETY_MULTIPLE)
  )
}

const TEXT = new TextDecoder()

function parseManifest(
  bytes: Uint8Array,
  expectedPhotoCount?: number | null
): PackManifest {
  const value = JSON.parse(TEXT.decode(bytes)) as Partial<PackManifest>
  if (
    typeof value.version !== "string" ||
    !Array.isArray(value.photos) ||
    value.photos.length > maxPhotoCount(expectedPhotoCount) ||
    value.photos.some(
      (photo) =>
        !photo ||
        typeof photo.id !== "string" ||
        !/^[a-f0-9]{16}$/i.test(photo.id) ||
        typeof photo.w !== "number" ||
        !Number.isFinite(photo.w) ||
        typeof photo.h !== "number" ||
        !Number.isFinite(photo.h)
    )
  ) {
    throw new Error("The dataset's manifest is invalid.")
  }
  return value as PackManifest
}

type FetchOptions = {
  limit: number
  signal?: AbortSignal
  // Called with each chunk's length and the declared total, if there was one.
  onChunk?: (added: number, total: number) => void
}

// Download one file, enforcing its ceiling as the bytes arrive so an oversized
// response is abandoned rather than buffered to completion.
async function fetchFile(
  url: string,
  { limit, signal, onChunk }: FetchOptions
): Promise<Uint8Array> {
  const response = await fetch(url, { signal })
  if (!response.ok) {
    throw new Error(`Could not load the dataset (${response.status}).`)
  }
  const total = Number(response.headers.get("content-length") ?? 0)
  if (total > limit) {
    await response.body?.cancel()
    throw new Error("A dataset file is unexpectedly large.")
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.length > limit) {
      throw new Error("A dataset file is unexpectedly large.")
    }
    onChunk?.(bytes.length, total)
    return bytes
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      signal?.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      length += value.length
      if (length > limit) {
        throw new Error("A dataset file is unexpectedly large.")
      }
      chunks.push(value)
      onChunk?.(value.length, total)
    }
  } catch (error) {
    void reader.cancel(error).catch(() => undefined)
    throw error
  }

  if (chunks.length === 1) return chunks[0]
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return bytes
}

export type LoadPackOptions = {
  expectedVersion?: string | null
  // The photo count the ingest published, used to size the guards above.
  expectedPhotoCount?: number | null
  // Whether the ingest saved a project cover, which decides `iconUrl`.
  hasIcon?: boolean
  onProgress?: (progress: PackProgress) => void
  signal?: AbortSignal
}

async function loadPack(
  slug: string,
  options: LoadPackOptions = {}
): Promise<RoboflowPack> {
  const {
    expectedVersion,
    expectedPhotoCount,
    hasIcon,
    onProgress = () => {},
    signal,
  } = options

  // Both totals only become known once each response's headers arrive, so
  // progress is reported against whatever has been declared so far.
  let loaded = 0
  const totals = new Map<string, number>()
  const report = (key: string) => (added: number, total: number) => {
    loaded += added
    if (total) totals.set(key, total)
    let combined = 0
    for (const value of totals.values()) combined += value
    onProgress({ loaded, total: totals.size === 2 ? combined : 0, step: "downloading" })
  }

  const [manifestBytes, signatures] = await Promise.all([
    fetchFile(roboflowAssetUrl(slug, MANIFEST_FILE, expectedVersion), {
      limit: scaledLimit(
        MANIFEST_BYTES_PER_PHOTO,
        MANIFEST_OVERHEAD_BYTES,
        expectedPhotoCount
      ),
      signal,
      onChunk: report(MANIFEST_FILE),
    }),
    fetchFile(roboflowAssetUrl(slug, COARSE_SIGNATURES_FILE, expectedVersion), {
      limit: scaledLimit(
        COARSE_SIG_BYTES,
        SIGNATURE_OVERHEAD_BYTES,
        expectedPhotoCount
      ),
      signal,
      onChunk: report(COARSE_SIGNATURES_FILE),
    }),
  ])

  onProgress({ loaded, total: loaded, step: "preparing" })
  const manifest = parseManifest(manifestBytes, expectedPhotoCount)
  if (expectedVersion && manifest.version !== expectedVersion) {
    throw new Error(
      "The dataset was re-ingested. Reload to fetch the new version."
    )
  }

  const ids = new Set(manifest.photos.map((photo) => photo.id))
  return {
    slug,
    version: manifest.version,
    manifest,
    signatures,
    iconUrl: hasIcon
      ? roboflowAssetUrl(slug, ICON_FILE, manifest.version)
      : null,
    // No fetch happens here — the URL is resolved when an <img> or the worker
    // asks for it, so a photo the mosaic never places is never transferred.
    thumbUrl: (id) =>
      ids.has(id) ? roboflowAssetUrl(slug, roboflowThumbPath(id)) : null,
    // Nothing to free: tiles live in the browser's HTTP cache, not in object
    // urls this module owns.
    release: () => {},
  }
}

// ─── Sharing one pack between the canvas and the reference picker ────────────
//
// Both mount at once and both want the manifest. Loading twice would mean two
// downloads of identical bytes, so callers take a reference instead and the
// last one to let go frees it.
//
// Progress is broadcast rather than tied to whoever happened to ask first: the
// picker is a child of the canvas, so its effect runs first and it would
// otherwise own the only callback while the canvas draws the progress bar.

type LivePack = {
  promise: Promise<RoboflowPack>
  refs: number
  listeners: Set<(progress: PackProgress) => void>
  controller: AbortController
}

const live = new Map<string, LivePack>()

export function acquirePack(
  slug: string,
  options: LoadPackOptions = {}
): Promise<RoboflowPack> {
  const { onProgress, ...rest } = options
  let entry = live.get(slug)

  if (entry) {
    entry.refs += 1
  } else {
    const listeners = new Set<(progress: PackProgress) => void>()
    const controller = new AbortController()
    const signal = rest.signal
      ? AbortSignal.any([rest.signal, controller.signal])
      : controller.signal
    const created: LivePack = {
      listeners,
      refs: 1,
      controller,
      promise: loadPack(slug, {
        ...rest,
        signal,
        onProgress: (progress) => {
          for (const listener of listeners) listener(progress)
        },
      }),
    }
    live.set(slug, created)
    // A failed load must not stay cached, or every later caller gets the error.
    void created.promise.catch(() => {
      if (live.get(slug) === created) live.delete(slug)
    })
    entry = created
  }

  if (onProgress) {
    const listeners = entry.listeners
    listeners.add(onProgress)
    void entry.promise.then(
      () => listeners.delete(onProgress),
      () => listeners.delete(onProgress)
    )
  }
  return entry.promise
}

export function releasePack(slug: string): void {
  const entry = live.get(slug)
  if (!entry) return
  entry.refs -= 1
  if (entry.refs > 0) return
  live.delete(slug)
  // Stop a download nobody can use. If it already finished, abort is a no-op.
  entry.controller.abort(new DOMException("Pack released", "AbortError"))
}
