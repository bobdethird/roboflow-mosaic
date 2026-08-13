// Durable copy of an ingested dataset, for serverless hosts.
//
// A Vercel instance cannot keep the library it builds, so the library is
// streamed to Blob as it is produced (lib/roboflow-sink.ts) and this module
// covers everything else the Blob copy is used for: durable ingest status,
// existence checks, and the keys the rest of the code addresses it by.
//
// Nothing downloads that zip in full, on either side. The asset route reads
// single files out of it with byte-range requests (lib/roboflow-archive.ts), so
// no instance ever needs the dataset on disk except the one that built it, and
// the browser only ever receives the tiles it actually draws.

import { head, put } from "@vercel/blob"

import { ICON_FILE, type IngestStatus } from "./roboflow"
import { STATUS_FILE } from "./roboflow-store"

const PREFIX = "roboflow"
export const ARCHIVE_FILE = "library.zip"
export const PUBLISHED_FILE = "published.json"

// Short: a re-ingest overwrites these keys in place, and every asset the
// browser caches hard is addressed by content hash or library version anyway.
export const STORE_MAX_AGE = 60

export function blobEnabled(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN)
}

export function blobKey(slug: string, relativePath: string): string {
  return `${PREFIX}/${slug}/${relativePath}`
}

export async function blobHasFile(
  slug: string,
  relativePath: string
): Promise<boolean> {
  try {
    await head(blobKey(slug, relativePath))
    return true
  } catch {
    return false
  }
}

export function blobHasDataset(slug: string): Promise<boolean> {
  return blobHasFile(slug, ARCHIVE_FILE)
}

export async function blobHasIcon(slug: string): Promise<boolean> {
  if (await blobHasFile(slug, ICON_FILE)) return true
  const text = await readBlobText(slug, PUBLISHED_FILE)
  if (!text) return false
  try {
    return Boolean((JSON.parse(text) as { hasIcon?: boolean }).hasIcon)
  } catch {
    return false
  }
}

export async function readBlobText(
  slug: string,
  relativePath: string
): Promise<string | null> {
  try {
    const meta = await head(blobKey(slug, relativePath))
    const url = new URL(meta.url)
    // Public Blob objects have a minimum 60-second cache lifetime. Bust that
    // cache with the current ETag so mutable status/manifest reads are fresh.
    url.searchParams.set("v", meta.etag)
    const response = await fetch(url, { cache: "no-store" })
    return response.ok ? await response.text() : null
  } catch {
    return null
  }
}

export async function readBlobStatus(
  slug: string
): Promise<IngestStatus | null> {
  const text = await readBlobText(slug, STATUS_FILE)
  if (!text) return null
  try {
    return JSON.parse(text) as IngestStatus
  } catch {
    return null
  }
}

// Ingest progress has to be visible to every instance, not just the one that
// started the job — GET polls land on a different lambda, and /tmp is not
// shared. Reads use the current ETag as a cache key so each overwrite is fresh.
export async function writeBlobStatus(
  slug: string,
  status: IngestStatus
): Promise<void> {
  await put(blobKey(slug, STATUS_FILE), JSON.stringify(status), {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
    cacheControlMaxAge: STORE_MAX_AGE,
  })
}

// Building an archive from a directory used to live here, for the disk-based
// publish and for the route that zipped the cache on demand. Neither exists
// now: `blobArchiveSink` writes the archive as the library is produced, and the
// asset route reads single files rather than whole archives.
