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

import { unzip, type Unzipped } from "fflate"

import {
  COARSE_SIGNATURES_FILE,
  ICON_FILE,
  MANIFEST_FILE,
  roboflowPackUrl,
  roboflowThumbPath,
} from "./roboflow"

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

type StoredPack = { slug: string; version: string; bytes: ArrayBuffer }

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
      if (key !== pack.slug) store.delete(key)
    }
    store.put(pack)
    return null
  })
}

async function forgetPack(slug: string): Promise<void> {
  await withStore("readwrite", async (store) => {
    store.delete(slug)
    return null
  })
}

async function download(
  slug: string,
  onProgress: (progress: PackProgress) => void,
  signal?: AbortSignal
): Promise<ArrayBuffer> {
  const response = await fetch(roboflowPackUrl(slug), { signal })
  if (!response.ok) {
    throw new Error(`Could not download the dataset (${response.status}).`)
  }
  const total = Number(response.headers.get("content-length") ?? 0)

  // No body reader means no progress; the archive still arrives.
  if (!response.body) return await response.arrayBuffer()

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let loaded = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    loaded += value.length
    onProgress({ loaded, total, step: "downloading" })
  }

  const bytes = new Uint8Array(loaded)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return bytes.buffer
}

function inflate(bytes: Uint8Array): Promise<Unzipped> {
  return new Promise((resolve, reject) => {
    unzip(bytes, (error, files) => {
      if (error) reject(error)
      else resolve(files)
    })
  })
}

const TEXT = new TextDecoder()

function buildPack(slug: string, files: Unzipped): RoboflowPack {
  const manifestBytes = files[MANIFEST_FILE]
  const signatures = files[COARSE_SIGNATURES_FILE]
  if (!manifestBytes || !signatures) {
    throw new Error("The dataset archive is missing its manifest.")
  }
  const manifest = JSON.parse(TEXT.decode(manifestBytes)) as PackManifest

  const urls = new Map<string, string>()
  const mint = (name: string, type: string): string | null => {
    const bytes = files[name]
    if (!bytes) return null
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }))
    urls.set(name, url)
    return url
  }

  for (const photo of manifest.photos) {
    mint(roboflowThumbPath(photo.id), "image/jpeg")
  }
  const iconUrl = mint(ICON_FILE, "image/jpeg")

  return {
    slug,
    version: manifest.version,
    manifest,
    signatures,
    iconUrl,
    thumbUrl: (id) => urls.get(roboflowThumbPath(id)) ?? null,
    release: () => {
      for (const url of urls.values()) URL.revokeObjectURL(url)
      urls.clear()
    },
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
    try {
      onProgress({ loaded: 0, total: 0, step: "unpacking" })
      return buildPack(slug, await inflate(new Uint8Array(stored.bytes)))
    } catch {
      // A corrupt cache entry is not worth diagnosing; fetch it again.
      await forgetPack(slug)
    }
  }

  const bytes = await download(slug, onProgress, signal)
  onProgress({ loaded: bytes.byteLength, total: bytes.byteLength, step: "unpacking" })
  const pack = buildPack(slug, await inflate(new Uint8Array(bytes)))
  await writeStored({ slug, version: pack.version, bytes })
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
    const created: LivePack = {
      listeners,
      refs: 1,
      promise: loadPack(slug, {
        ...rest,
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
  // Safe mid-flight: the download finishes, then the urls are freed.
  void entry.promise.then(
    (pack) => pack.release(),
    () => {}
  )
}
