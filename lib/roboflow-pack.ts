// The browser's copy of an ingested dataset.
//
// A mosaic uses almost every photo in its library — tile reuse is capped, and a
// mosaic has tens of thousands of cells — so fetching thumbnails one at a time
// was thousands of requests to move bytes the page was always going to need.
// Instead the whole library arrives as one zip and lives here: the manifest,
// the signature blob, the cover, and every thumbnail.
//
// Once unpacked, each tile gets an object url. The mosaic worker, the hover
// popup, the zoom overlay, and the reference picker all read those, so after
// this download the page makes no further requests for dataset bytes.
//
// The archive is kept in IndexedDB under its library version, so a reload skips
// the download and a re-ingest (which stamps a new version) does not.

import { Unzip, UnzipInflate, type UnzipFile } from "fflate"

import {
  COARSE_SIGNATURES_FILE,
  ICON_FILE,
  MANIFEST_FILE,
  roboflowPackUrl,
  roboflowThumbPath,
} from "./roboflow"
import { MAX_EXPANDED_PACK_BYTES, MAX_PACK_BYTES, MIB } from "./roboflow-limits"

export { MAX_PACK_BYTES } from "./roboflow-limits"

export type PackProgress = {
  // Bytes received so far, and the total when the server declared one.
  loaded: number
  total: number
  step: "downloading" | "unpacking"
}

export type RoboflowPack = {
  slug: string
  version: string
  manifest: PackManifest
  signatures: Uint8Array
  iconUrl: string | null
  // Object url for a tile, or null when the archive has no such thumbnail.
  thumbUrl: (id: string) => string | null
  // Revoke every object url. The pack is unusable afterwards.
  release: () => void
}

export type PackManifest = {
  version: string
  photos: { id: string; w: number; h: number; file?: string }[]
}

const DB_NAME = "roboflow-packs"
const DB_VERSION = 1
const STORE = "archives"
const MAX_MANIFEST_BYTES = 8 * MIB
const MAX_SIGNATURE_BYTES = 32 * MIB
const MAX_ICON_BYTES = 12 * MIB
const MAX_THUMB_BYTES = 2 * MIB
const MAX_PACK_PHOTOS = 50_000
type StoredPack = {
  slug: string
  version: string
  archive?: Blob
  // Version-1 cache records stored one ArrayBuffer. Read it once and migrate.
  bytes?: ArrayBuffer
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE, { keyPath: "slug" })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

// IndexedDB is a cache here, never a source of truth — every failure just means
// the archive gets downloaded again.
async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => Promise<T>
): Promise<T | null> {
  if (typeof indexedDB === "undefined") return null
  let db: IDBDatabase | null = null
  try {
    db = await openDb()
    return await run(db.transaction(STORE, mode).objectStore(STORE))
  } catch {
    return null
  } finally {
    db?.close()
  }
}

async function readStored(slug: string): Promise<StoredPack | null> {
  return withStore("readonly", async (store) => {
    const found = await promisify<StoredPack | undefined>(store.get(slug))
    return found ?? null
  })
}

// Keep only this dataset: a library is tens of megabytes and the page shows one
// at a time, so holding onto the others just crowds the origin's storage quota.
async function writeStored(pack: StoredPack): Promise<void> {
  await withStore("readwrite", async (store) => {
    const keys = await promisify<IDBValidKey[]>(store.getAllKeys())
    for (const key of keys) {
      if (key !== pack.slug) await promisify(store.delete(key))
    }
    await promisify(store.put(pack))
    return null
  })
}

async function forgetPack(slug: string): Promise<void> {
  await withStore("readwrite", async (store) => {
    await promisify(store.delete(slug))
    return null
  })
}

const TEXT = new TextDecoder()

function joinChunks(chunks: Uint8Array[], length: number): Uint8Array {
  if (chunks.length === 1) return chunks[0]
  const output = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.length
  }
  return output
}

function readZipFile(
  file: UnzipFile,
  onChunk: (chunk: Uint8Array) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    file.ondata = (error, chunk, final) => {
      if (error) {
        reject(error)
        return
      }
      try {
        if (chunk.length) onChunk(chunk)
      } catch (chunkError) {
        reject(chunkError)
        return
      }
      if (final) resolve()
    }
    try {
      file.start()
    } catch (error) {
      reject(error)
    }
  })
}

type UnpackedParts = {
  manifest: Uint8Array | null
  signatures: Uint8Array | null
  urls: Map<string, string>
}

function maxEntryBytes(name: string): number {
  if (name === MANIFEST_FILE) return MAX_MANIFEST_BYTES
  if (name === COARSE_SIGNATURES_FILE) return MAX_SIGNATURE_BYTES
  if (name === ICON_FILE) return MAX_ICON_BYTES
  return MAX_THUMB_BYTES
}

function parseManifest(bytes: Uint8Array): PackManifest {
  const value = JSON.parse(TEXT.decode(bytes)) as Partial<PackManifest>
  if (
    typeof value.version !== "string" ||
    !Array.isArray(value.photos) ||
    value.photos.length > MAX_PACK_PHOTOS ||
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
    throw new Error("The dataset archive contains an invalid manifest.")
  }
  return value as PackManifest
}

function buildPack(
  slug: string,
  parts: UnpackedParts,
  expectedVersion?: string | null
): RoboflowPack {
  const manifestBytes = parts.manifest
  const signatures = parts.signatures
  if (!manifestBytes || !signatures) {
    throw new Error("The dataset archive is missing its manifest.")
  }
  const manifest = parseManifest(manifestBytes)
  if (expectedVersion && manifest.version !== expectedVersion) {
    throw new Error(
      "The downloaded dataset is stale. Reload to fetch the newly published version."
    )
  }

  const used = new Set<string>()
  for (const photo of manifest.photos ?? []) {
    used.add(roboflowThumbPath(photo.id))
  }
  used.add(ICON_FILE)
  for (const [name, url] of parts.urls) {
    if (!used.has(name)) {
      URL.revokeObjectURL(url)
      parts.urls.delete(name)
    }
  }
  const iconUrl = parts.urls.get(ICON_FILE) ?? null

  return {
    slug,
    version: manifest.version,
    manifest,
    signatures,
    iconUrl,
    thumbUrl: (id) => parts.urls.get(roboflowThumbPath(id)) ?? null,
    release: () => {
      for (const url of parts.urls.values()) URL.revokeObjectURL(url)
      parts.urls.clear()
    },
  }
}

type UnpackOptions = {
  expectedVersion?: string | null
  signal?: AbortSignal
  total?: number
  onProgress?: (progress: PackProgress) => void
  onArchiveChunk?: (chunk: Uint8Array) => void
}

export async function unpackArchive(
  slug: string,
  stream: ReadableStream<Uint8Array>,
  options: UnpackOptions = {}
): Promise<RoboflowPack> {
  const parts: UnpackedParts = {
    manifest: null,
    signatures: null,
    urls: new Map(),
  }
  const pending: Promise<void>[] = []
  let streamError: unknown = null
  let expanded = 0

  const unzipper = new Unzip((file) => {
    const wanted =
      file.name === MANIFEST_FILE ||
      file.name === COARSE_SIGNATURES_FILE ||
      file.name === ICON_FILE ||
      (file.name.startsWith("thumbs/") && file.name.endsWith(".jpg"))
    if (!wanted) return
    const entryLimit = maxEntryBytes(file.name)
    if (file.originalSize !== undefined && file.originalSize > entryLimit) {
      streamError = new Error("A dataset archive entry is unexpectedly large.")
      return
    }

    const chunks: Uint8Array[] = []
    let length = 0
    const task = readZipFile(file, (chunk) => {
      expanded += chunk.length
      length += chunk.length
      if (length > entryLimit) {
        throw new Error("A dataset archive entry is unexpectedly large.")
      }
      if (expanded > MAX_EXPANDED_PACK_BYTES) {
        throw new Error("The unpacked dataset is too large for this browser.")
      }
      chunks.push(chunk)
    })
      .then(() => {
        const bytes = joinChunks(chunks, length)
        if (file.name === MANIFEST_FILE) parts.manifest = bytes
        else if (file.name === COARSE_SIGNATURES_FILE) parts.signatures = bytes
        else {
          const previous = parts.urls.get(file.name)
          if (previous) URL.revokeObjectURL(previous)
          parts.urls.set(
            file.name,
            URL.createObjectURL(
              new Blob([bytes as BlobPart], { type: "image/jpeg" })
            )
          )
        }
      })
      .catch((error: unknown) => {
        streamError ??= error
      })
    pending.push(task)
  })
  unzipper.register(UnzipInflate)

  const reader = stream.getReader()
  let loaded = 0
  try {
    for (;;) {
      options.signal?.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      loaded += value.length
      if (loaded > MAX_PACK_BYTES) {
        throw new Error(
          `This dataset archive is too large for the browser (limit: ${MAX_PACK_BYTES / MIB} MB).`
        )
      }
      options.onArchiveChunk?.(value)
      unzipper.push(value)
      if (streamError) throw streamError
      options.onProgress?.({
        loaded,
        total: options.total ?? 0,
        step: "downloading",
      })
    }
    unzipper.push(new Uint8Array(), true)
    await Promise.all(pending)
    if (streamError) throw streamError
    return buildPack(slug, parts, options.expectedVersion)
  } catch (error) {
    void reader.cancel(error).catch(() => undefined)
    for (const url of parts.urls.values()) URL.revokeObjectURL(url)
    parts.urls.clear()
    throw error
  }
}

function storedArchive(stored: StoredPack): Blob | null {
  if (stored.archive instanceof Blob) return stored.archive
  if (stored.bytes) return new Blob([stored.bytes], { type: "application/zip" })
  return null
}

async function downloadPack(
  slug: string,
  options: LoadPackOptions
): Promise<{ pack: RoboflowPack; archive: Blob }> {
  const { expectedVersion, onProgress = () => {}, signal } = options
  const response = await fetch(roboflowPackUrl(slug), { signal })
  if (!response.ok) {
    throw new Error(`Could not download the dataset (${response.status}).`)
  }
  const total = Number(response.headers.get("content-length") ?? 0)
  if (total > MAX_PACK_BYTES) {
    await response.body?.cancel()
    throw new Error(
      `This dataset archive is too large for the browser (limit: ${MAX_PACK_BYTES / MIB} MB).`
    )
  }

  if (!response.body) {
    const archive = await response.blob()
    if (archive.size > MAX_PACK_BYTES) {
      throw new Error(
        `This dataset archive is too large for the browser (limit: ${MAX_PACK_BYTES / MIB} MB).`
      )
    }
    const pack = await unpackArchive(slug, archive.stream(), {
      expectedVersion,
      signal,
      total: archive.size,
      onProgress,
    })
    return { pack, archive }
  }

  const chunks: BlobPart[] = []
  const pack = await unpackArchive(slug, response.body, {
    expectedVersion,
    signal,
    total,
    onProgress,
    onArchiveChunk: (chunk) => chunks.push(chunk as BlobPart),
  })
  return {
    pack,
    archive: new Blob(chunks, { type: "application/zip" }),
  }
}

export type LoadPackOptions = {
  expectedVersion?: string | null
  onProgress?: (progress: PackProgress) => void
  signal?: AbortSignal
}

// Get the dataset into the browser, from IndexedDB when it is already there.
//
// `expectedVersion` is the manifest version the page is expecting (from the
// ingest status). A stored archive that does not match it is stale — a
// re-ingest happened — so it is discarded rather than served.
async function loadPack(
  slug: string,
  options: LoadPackOptions = {}
): Promise<RoboflowPack> {
  const { expectedVersion, onProgress = () => {}, signal } = options

  const stored = await readStored(slug)
  if (stored && (!expectedVersion || stored.version === expectedVersion)) {
    const archive = storedArchive(stored)
    try {
      if (!archive || archive.size > MAX_PACK_BYTES)
        throw new Error("Bad cache")
      onProgress({ loaded: 0, total: 0, step: "unpacking" })
      const pack = await unpackArchive(slug, archive.stream(), {
        expectedVersion,
        signal,
      })
      // Migrate old ArrayBuffer records without retaining a second copy.
      if (!stored.archive) {
        await writeStored({ slug, version: pack.version, archive })
      }
      return pack
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error
      // A corrupt cache entry is not worth diagnosing; fetch it again.
      await forgetPack(slug)
    }
  }

  const { pack, archive } = await downloadPack(slug, options)
  onProgress({ loaded: archive.size, total: archive.size, step: "unpacking" })
  await writeStored({ slug, version: pack.version, archive })
  return pack
}

// ─── Sharing one pack between the canvas and the reference picker ────────────
//
// Both mount at once and both want every thumbnail. Loading twice would mean
// two downloads and two sets of object urls for identical bytes, so callers
// take a reference instead and the last one to let go frees it.
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
  // Stop a download/unpack nobody can use. If it already finished, abort is a
  // no-op and the resolved pack's URLs are released below.
  entry.controller.abort(new DOMException("Pack released", "AbortError"))
  void entry.promise.then(
    (pack) => pack.release(),
    () => {}
  )
}
