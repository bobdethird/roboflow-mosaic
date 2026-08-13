// Reading single files out of a published library archive.
//
// A serverless instance has no copy of the dataset on disk unless it ran the
// ingest, and the archive for a large dataset is hundreds of megabytes, so the
// asset route never downloads it. It reads the archive's central directory once
// per instance and then pulls each requested file with a byte-range request
// against the Blob CDN.
//
// The index is pinned to the archive's ETag: a re-ingest overwrites the key in
// place, and offsets from the previous archive would otherwise point at the
// wrong bytes.

import { head } from "@vercel/blob"

import { ARCHIVE_FILE, blobKey } from "./roboflow-blob"
import {
  readZipEntry,
  readZipIndex,
  type RangeReader,
  type ZipIndex,
} from "./zip-index"

type Archive = {
  etag: string
  index: ZipIndex
  read: RangeReader
}

// One entry per dataset, for as long as this instance lives. Building it costs
// a read of the central directory, which is worth avoiding per request.
const archives = new Map<string, Promise<Archive | null>>()

function rangeReader(url: string): RangeReader {
  return async (start, end) => {
    const response = await fetch(url, {
      headers: { range: `bytes=${start}-${end}` },
      cache: "no-store",
    })
    if (!response.ok) {
      throw new Error(
        `Range request failed (${response.status} ${response.statusText}).`
      )
    }
    return new Uint8Array(await response.arrayBuffer())
  }
}

async function openArchive(slug: string): Promise<Archive | null> {
  const meta = await head(blobKey(slug, ARCHIVE_FILE)).catch(() => null)
  if (!meta) return null

  const url = new URL(meta.url)
  // Distinct cache key per published version, so a range never mixes archives.
  url.searchParams.set("v", meta.etag)
  const read = rangeReader(url.toString())
  const index = await readZipIndex(read, meta.size)
  return { etag: meta.etag, index, read }
}

function archiveFor(slug: string): Promise<Archive | null> {
  const existing = archives.get(slug)
  if (existing) return existing
  const opened = openArchive(slug).catch((error: unknown) => {
    // Never cache a failure: the next request should be free to retry.
    archives.delete(slug)
    throw error
  })
  archives.set(slug, opened)
  return opened
}

// One file out of the published archive, or null when the dataset or the file
// was never published.
export async function readArchiveFile(
  slug: string,
  relativePath: string
): Promise<Uint8Array | null> {
  const archive = await archiveFor(slug)
  if (!archive) return null
  const entry = archive.index.get(relativePath)
  if (!entry) return null
  return readZipEntry(archive.read, entry)
}

// Whether the published archive holds this file, without reading its bytes.
export async function archiveHasFile(
  slug: string,
  relativePath: string
): Promise<boolean> {
  const archive = await archiveFor(slug).catch(() => null)
  return Boolean(archive?.index.has(relativePath))
}
