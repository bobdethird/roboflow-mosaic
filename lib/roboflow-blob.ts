// Durable copy of an ingested dataset, for serverless hosts.
//
// A Vercel instance cannot keep the library it builds, so each thumbnail and
// each immutable snapshot is written to Blob as its own object. This module
// covers the keys the rest of the code addresses those objects by, plus durable
// ingest status and existence checks.
//
// Nothing downloads a library whole, on either side. The asset route reads
// single files; the browser only ever receives the tiles it actually draws.

import { mkdir, rename, writeFile } from "node:fs/promises"
import path from "node:path"

import { head, put } from "@vercel/blob"

import {
  COARSE_SIGNATURES_FILE,
  ICON_FILE,
  MANIFEST_FILE,
  snapshotDir,
  type IngestStatus,
} from "./roboflow"
import { STATUS_FILE, datasetDir } from "./roboflow-store"

const PREFIX = "roboflow"
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
  return blobHasFile(slug, MANIFEST_FILE)
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
  const bytes = await readBlobBytes(slug, relativePath)
  return bytes ? new TextDecoder().decode(bytes) : null
}

export async function readBlobBytes(
  slug: string,
  relativePath: string
): Promise<Uint8Array | null> {
  try {
    const meta = await head(blobKey(slug, relativePath))
    const url = new URL(meta.url)
    // Public Blob objects have a minimum 60-second cache lifetime. Bust that
    // cache with the current ETag so mutable status/manifest reads are fresh.
    url.searchParams.set("v", meta.etag)
    const response = await fetch(url, { cache: "no-store" })
    if (!response.ok) return null
    return new Uint8Array(await response.arrayBuffer())
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

export type LibrarySnapshot = {
  version: string
  manifest: Buffer
  signatures: Buffer
}

async function writeAtomic(file: string, bytes: Buffer): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  await writeFile(tmp, bytes)
  await rename(tmp, file)
}

// Write one complete manifest + signature pair, then the latest pointers.
// Clients are told about `version` only after this resolves, so they never
// observe a torn snapshot.
export async function publishLibrarySnapshot(
  slug: string,
  snapshot: LibrarySnapshot,
  options: { abortSignal?: AbortSignal; directory?: string } = {}
): Promise<void> {
  const dir = snapshotDir(snapshot.version)
  const files: [string, Buffer, string][] = [
    [`${dir}/${MANIFEST_FILE}`, snapshot.manifest, "application/json"],
    [
      `${dir}/${COARSE_SIGNATURES_FILE}`,
      snapshot.signatures,
      "application/octet-stream",
    ],
    [MANIFEST_FILE, snapshot.manifest, "application/json"],
    [
      COARSE_SIGNATURES_FILE,
      snapshot.signatures,
      "application/octet-stream",
    ],
  ]

  if (blobEnabled() && !options.directory) {
    for (const [name, bytes, contentType] of files) {
      await put(blobKey(slug, name), bytes, {
        access: "public",
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType,
        cacheControlMaxAge: STORE_MAX_AGE,
        abortSignal: options.abortSignal,
      })
    }
    return
  }

  const root = options.directory ?? datasetDir(slug)
  for (const [name, bytes] of files) {
    await writeAtomic(path.join(root, name), bytes)
  }
}
