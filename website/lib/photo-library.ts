// Shared mosaic photo libraries, hosted in private Supabase Storage buckets so
// every visitor matches against the same photo set instead of a per-browser
// cache. There are two collections — `nyc-mosaic` and `caden-mosaic` — each laid
// out identically in its own bucket and selectable from the mosaic page.
//
// The load is split by size:
//   - signatures-coarse.bin — every tile's 8x8 comparison signature, downloaded
//     once and cached locally keyed by bucket + manifest version.
//   - thumbs/<id>.jpg — fetched lazily by the worker only for placed tiles, via
//     this app's proxy route so the buckets can remain private.
//
// Bucket layout (per bucket):
//   manifest.json   { version, photos: [{ id, w, h, fullPath?, takenAt?, location? }] }   (order == signatures)
//   signatures-coarse.bin  concatenated uint16 fixed-point coarse signatures
//   signatures.bin         legacy/full uint8 signatures, SIG_BYTES per photo
//   thumbs/<id>.jpg one downscaled thumbnail per photo
//   originals/<id>  optional full-resolution source image for hover/open preview

import { SIGNATURE_GRID } from "./mosaic"

// Bytes per signature: SIGNATURE_GRID² cells × 3 channels, one uint8 each. The
// stored signatures are canvas pixel averages (already integers 0–255), so a
// uint8 round-trip is lossless.
export const SIG_BYTES = SIGNATURE_GRID * SIGNATURE_GRID * 3
const COARSE_SIGNATURE_GRID = Math.max(1, SIGNATURE_GRID >> 1)
const COARSE_SIG_VALUES = COARSE_SIGNATURE_GRID * COARSE_SIGNATURE_GRID * 3
// The worker compares on 8x8 signatures derived by averaging 2x2 blocks of the
// full uint8 signature. Store each value as the exact 0..1020 sum (value * 4).
export const COARSE_SIG_BYTES = COARSE_SIG_VALUES * 2

// Public Supabase project URL. Falls back to the known project so the library
// works even if the env var isn't set (e.g. on a fresh deploy); the value is a
// public URL, not a secret.
export const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "") ??
  "https://qnpwjltgxgkohtqhprux.supabase.co"

// The private photo collections. Each stays private and is reachable only
// through this app's `/api/mosaic` proxy (which holds the secret key).
// `knicks-mosaic` is a temporary/experimental collection: its tiles are frames
// sampled (~0.33fps) from the scraped Knicks videos, used to prototype the photo
// mosaic on the /knicks-mosaic page. It is intentionally last so the two-way
// switch on /mosaic keeps toggling only between nyc and caden.
export const MOSAIC_BUCKETS = [
  "nyc-mosaic",
  "caden-mosaic",
  "knicks-mosaic",
] as const
export type MosaicBucket = (typeof MOSAIC_BUCKETS)[number]

// The collection shown first; clicking the page's toggle switches to the other.
export const DEFAULT_BUCKET: MosaicBucket = "nyc-mosaic"

// Short human label per collection (used by the page's switch link).
export const BUCKET_LABELS: Record<MosaicBucket, string> = {
  "nyc-mosaic": "nyc",
  "caden-mosaic": "personal",
  "knicks-mosaic": "knicks",
}

// Heading + blurb shown beside the mosaic, one per collection. Placeholder copy
// for now — reword freely without touching the component.
export type BucketCopy = { heading: string; description: string }

export const BUCKET_COPY: Record<MosaicBucket, BucketCopy> = {
  "nyc-mosaic": {
    heading: "New York, in pieces",
    description:
      "A mosaic rebuilt from photos I shot around New York City. Drop in any reference image and watch it reassemble out of the city's streets, skylines, and small in-between moments — hover any tile to see the shot behind it.",
  },
  "caden-mosaic": {
    heading: "Bits of my life",
    description:
      "A mosaic stitched together from my own photos — friends, travels, and the everyday moments worth keeping. Add a reference image and it rebuilds from my memories; hover any tile to open the original.",
  },
  "knicks-mosaic": {
    heading: "Knicks, frame by frame",
    description:
      "An experimental mosaic built from thousands of frames sampled out of Knicks footage. Drop in a reference image and watch it reassemble from the season — hover any tile to see the moment behind it.",
  },
}

export function isMosaicBucket(value: string): value is MosaicBucket {
  return (MOSAIC_BUCKETS as readonly string[]).includes(value)
}

// Collections that require a password before they can be viewed. The personal
// collection is gated: the password is checked server-side (against
// MOSAIC_PERSONAL_PASSWORD) at `/api/mosaic/unlock`, which sets an httpOnly
// cookie; the proxy then refuses to serve this bucket's objects without it.
export const GATED_BUCKETS: readonly MosaicBucket[] = ["caden-mosaic"]

export function isGatedBucket(bucket: MosaicBucket): boolean {
  return GATED_BUCKETS.includes(bucket)
}

const MOSAIC_API_BASE = "/api/mosaic"

// Endpoint that validates the personal-collection password and toggles the
// unlock cookie. Kept here so client and server agree on the path.
export const MOSAIC_UNLOCK_PATH = `${MOSAIC_API_BASE}/unlock`

export const MANIFEST_PATH = "manifest.json"
export const SIGNATURES_PATH = "signatures.bin"
export const COARSE_SIGNATURES_PATH = "signatures-coarse.bin"

function encodeStoragePath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")
}

// Proxy URL for an object in a bucket: /api/mosaic/<bucket>/<path>. The bucket is
// part of the path so the proxy knows which private bucket to read from.
export function mosaicObjectUrl(bucket: MosaicBucket, path: string): string {
  return `${MOSAIC_API_BASE}/${bucket}/${encodeStoragePath(path)}`
}

export function manifestUrl(bucket: MosaicBucket): string {
  return mosaicObjectUrl(bucket, MANIFEST_PATH)
}

export function signaturesUrl(
  bucket: MosaicBucket,
  path = SIGNATURES_PATH
): string {
  return mosaicObjectUrl(bucket, path)
}

// Storage path of a single tile's thumbnail.
export function thumbPath(id: string): string {
  return `thumbs/${id}.jpg`
}

// Proxy URL of a single tile's thumbnail. Used both to build hydrate items here
// and (re)constructed by the worker when it lazily decodes a placed tile.
export function thumbUrl(bucket: MosaicBucket, id: string): string {
  return mosaicObjectUrl(bucket, thumbPath(id))
}

export function originalPath(id: string): string {
  return `originals/${id}`
}

export function originalUrl(bucket: MosaicBucket, id: string): string {
  return mosaicObjectUrl(bucket, originalPath(id))
}

export type ManifestPhoto = {
  id: string
  w: number
  h: number
  fullPath?: string
  takenAt?: string
  gallery?: string
  galleryTitle?: string
  sourceUrl?: string
  location?: {
    lat: number
    lng: number
  }
  // Source video id for tiles that are frames sampled from footage (the knicks
  // collection). Lets the UI report how many distinct clips a mosaic uses.
  video?: string
}
export type Manifest = { version: string; photos: ManifestPhoto[] }

// A library tile ready to hydrate into the mosaic worker.
export type LibraryItem = {
  id: string
  sig: Uint8Array
  w: number
  h: number
  takenAt?: string
  gallery?: string
  galleryTitle?: string
  sourceUrl?: string
  location?: ManifestPhoto["location"]
  // Source video id for frame-sampled tiles (see ManifestPhoto.video).
  video?: string
  fullUrl?: string
  url: string
}

// ─── Local signature cache (IndexedDB) ───────────────────────────────────────
// signatures.bin is the only large up-front download (~768 B × N). We stash it
// keyed by bucket + manifest version so repeat visits skip the re-download; a new
// version overwrites that bucket's record, so stale signatures can't linger.

const CACHE_DB = "mosaic-library"
const CACHE_STORE = "kv"

function sigKey(bucket: MosaicBucket, path: string): string {
  return `signatures:${bucket}:${path}`
}

type SigRecord = { key: string; version: string; bytes: Blob }

function openCache(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(CACHE_DB, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(CACHE_STORE)) {
        db.createObjectStore(CACHE_STORE, { keyPath: "key" })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function readCachedSignatures(
  bucket: MosaicBucket,
  path: string,
  version: string
): Promise<ArrayBuffer | null> {
  try {
    const db = await openCache()
    const rec = await new Promise<SigRecord | undefined>((resolve, reject) => {
      const req = db
        .transaction(CACHE_STORE, "readonly")
        .objectStore(CACHE_STORE)
        .get(sigKey(bucket, path))
      req.onsuccess = () => resolve(req.result as SigRecord | undefined)
      req.onerror = () => reject(req.error)
    })
    if (!rec || rec.version !== version) return null
    return await rec.bytes.arrayBuffer()
  } catch {
    return null
  }
}

async function writeCachedSignatures(
  bucket: MosaicBucket,
  path: string,
  version: string,
  bytes: ArrayBuffer
): Promise<void> {
  try {
    const db = await openCache()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(CACHE_STORE, "readwrite")
      tx.objectStore(CACHE_STORE).put({
        key: sigKey(bucket, path),
        version,
        bytes: new Blob([bytes]),
      } satisfies SigRecord)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch {
    // Best-effort: a failed cache write just means re-downloading next time.
  }
}

// ─── Load ────────────────────────────────────────────────────────────────────

async function fetchManifest(bucket: MosaicBucket): Promise<Manifest> {
  // Default cache mode lets the browser revalidate via ETag (cheap 304s), so the
  // version is always fresh without re-downloading an unchanged manifest.
  const res = await fetch(manifestUrl(bucket))
  if (!res.ok) throw new Error(`manifest fetch failed (${res.status})`)
  const manifest = (await res.json()) as Manifest
  if (!manifest?.photos?.length) throw new Error("manifest is empty")
  return manifest
}

async function fetchSignatureBytes(
  bucket: MosaicBucket,
  path: string,
  version: string
): Promise<Uint8Array> {
  const cached = await readCachedSignatures(bucket, path, version)
  if (cached) return new Uint8Array(cached)
  const res = await fetch(signaturesUrl(bucket, path))
  if (!res.ok) throw new Error(`signatures fetch failed (${res.status})`)
  const buf = await res.arrayBuffer()
  void writeCachedSignatures(bucket, path, version, buf)
  return new Uint8Array(buf)
}

async function fetchSignatures(
  bucket: MosaicBucket,
  version: string,
  photoCount: number
): Promise<{ bytes: Uint8Array; bytesPerSig: number }> {
  try {
    const bytes = await fetchSignatureBytes(
      bucket,
      COARSE_SIGNATURES_PATH,
      version
    )
    if (bytes.length >= photoCount * COARSE_SIG_BYTES) {
      return { bytes, bytesPerSig: COARSE_SIG_BYTES }
    }
  } catch {
    // Older buckets may not have the coarse artifact yet; fall back to the
    // legacy full signatures so the site keeps working until the bucket is
    // republished.
  }

  const bytes = await fetchSignatureBytes(bucket, SIGNATURES_PATH, version)
  return { bytes, bytesPerSig: SIG_BYTES }
}

// The current library version (manifest timestamp), or null if it can't be
// read. A re-seed changes this, so callers can use it to invalidate anything
// derived from a previous version (e.g. a cached, already-generated mosaic).
export async function fetchLibraryVersion(
  bucket: MosaicBucket
): Promise<string | null> {
  try {
    return (await fetchManifest(bucket)).version
  } catch {
    return null
  }
}

// Fetch a collection's shared library: its version, plus the tiles (manifest
// order + dims, the signatures blob cached by bucket + version, and per-tile
// thumbnail URLs). Returns an empty list on any failure so the UI can degrade
// to "no photos" rather than throwing (e.g. a bucket that hasn't been seeded).
export async function loadLibrary(
  bucket: MosaicBucket
): Promise<{ version: string; items: LibraryItem[] }> {
  try {
    const manifest = await fetchManifest(bucket)
    const n = manifest.photos.length
    const { bytes, bytesPerSig } = await fetchSignatures(
      bucket,
      manifest.version,
      n
    )
    if (bytes.length < n * bytesPerSig) {
      throw new Error(
        `signatures too short: ${bytes.length} < ${n * bytesPerSig}`
      )
    }
    const items: LibraryItem[] = new Array(n)
    for (let i = 0; i < n; i++) {
      const {
        id,
        w,
        h,
        fullPath,
        takenAt,
        gallery,
        galleryTitle,
        sourceUrl,
        location,
        video,
      } =
        manifest.photos[i]
      const base = i * bytesPerSig
      items[i] = {
        id,
        sig: bytes.subarray(base, base + bytesPerSig),
        w,
        h,
        takenAt,
        gallery,
        galleryTitle,
        sourceUrl,
        location,
        video,
        fullUrl: fullPath ? mosaicObjectUrl(bucket, fullPath) : undefined,
        url: thumbUrl(bucket, id),
      }
    }
    return { version: manifest.version, items }
  } catch {
    return { version: "", items: [] }
  }
}
