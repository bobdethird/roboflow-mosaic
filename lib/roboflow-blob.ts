// Durable copy of an ingested dataset, for serverless hosts.
//
// The library is built on local disk the same way it always was. A Vercel
// instance cannot keep that directory, so the finished library is packed as a
// stream and uploaded once — a single PUT, not one per thumbnail or a second
// archive written to /tmp.
//
// Nothing downloads that zip back onto a server. The browser fetches it whole
// from the Blob CDN and reads every tile out of it locally (lib/roboflow-pack.ts),
// so no instance ever needs the dataset on disk except the one that built it.

import { head, put } from "@vercel/blob"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { Readable } from "node:stream"
import { ZipFile } from "yazl"

import { ICON_FILE, MANIFEST_FILE, type IngestStatus } from "./roboflow"
import { STATUS_FILE, type ProgressReporter } from "./roboflow-store"

const PREFIX = "roboflow"
export const ARCHIVE_FILE = "library.zip"
const META_FILE = "published.json"

// Short: a re-ingest overwrites these keys in place, and the browser keeps its
// own copy of the archive keyed by library version anyway.
const STORE_MAX_AGE = 60

const SKIP_DIRS = new Set(["source"])
const SKIP_FILES = new Set([STATUS_FILE, "export.zip", ARCHIVE_FILE, META_FILE])

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

// Public CDN url of a published file, or null if it was never published. The
// pack route hands this straight to the browser as a redirect, so the bytes
// never pass through a function.
export async function blobUrl(
  slug: string,
  relativePath: string
): Promise<string | null> {
  try {
    const meta = await head(blobKey(slug, relativePath))
    const url = new URL(meta.url)
    // Archive keys are overwritten on refresh. The ETag gives every version a
    // distinct CDN cache key, so a freshly published manifest never receives
    // the previous archive for up to STORE_MAX_AGE seconds.
    url.searchParams.set("v", meta.etag)
    return url.toString()
  } catch {
    return null
  }
}

export async function blobHasIcon(slug: string): Promise<boolean> {
  if (await blobHasFile(slug, ICON_FILE)) return true
  const text = await readBlobText(slug, META_FILE)
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

async function libraryFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, {
    withFileTypes: true,
    recursive: true,
  })
  const files: string[] = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const relative = path
      .relative(directory, path.join(entry.parentPath, entry.name))
      .split(path.sep)
      .join("/")
    const [top] = relative.split("/")
    if (SKIP_DIRS.has(top) || SKIP_FILES.has(relative)) continue
    if (relative.endsWith(".tmp")) continue
    files.push(relative)
  }
  return files
}

// Thumbnails are already JPEG; deflating them only burns CPU, so entries go in
// stored. That also makes the archive cheap for the browser to unpack.
function addAll(zipfile: ZipFile, directory: string, files: string[]): void {
  for (const relative of files) {
    zipfile.addFile(path.join(directory, relative), relative, {
      compress: false,
    })
  }
  zipfile.end()
}

function libraryArchiveNodeStream(
  directory: string,
  files: string[]
): Readable {
  const zipfile = new ZipFile()
  addAll(zipfile, directory, files)
  // @types/yazl declares the minimal NodeJS interface, but this is a
  // stream.PassThrough at runtime.
  return zipfile.outputStream as Readable
}

// The archive as a stream, built on the fly from a dataset directory. Used by
// the pack route when there is no Blob store to redirect the browser to, which
// is the normal case in local development.
export async function libraryArchiveStream(
  directory: string
): Promise<ReadableStream<Uint8Array> | null> {
  const files = await libraryFiles(directory)
  if (!files.length) return null
  return Readable.toWeb(
    libraryArchiveNodeStream(directory, files)
  ) as ReadableStream<Uint8Array>
}

export async function publishFile(
  slug: string,
  directory: string,
  relativePath: string,
  abortSignal?: AbortSignal
): Promise<void> {
  const body = await readFile(path.join(directory, relativePath))
  await put(blobKey(slug, relativePath), body, {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: STORE_MAX_AGE,
    abortSignal,
  })
}

export async function publishDataset(
  slug: string,
  directory: string,
  report: ProgressReporter,
  abortSignal?: AbortSignal
): Promise<void> {
  const files = await libraryFiles(directory)
  if (!files.length) {
    throw new Error("Nothing to publish — the library was empty.")
  }

  report("Packing library", 0, files.length)
  const archive = libraryArchiveNodeStream(directory, files)
  try {
    report("Uploading library", 0, 0)
    await put(blobKey(slug, ARCHIVE_FILE), archive, {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/zip",
      cacheControlMaxAge: STORE_MAX_AGE,
      multipart: true,
      abortSignal,
      onUploadProgress: (event) => {
        report("Uploading library", event.loaded, event.total)
      },
    })
  } finally {
    archive.destroy()
  }

  const manifest = files.find((file) => file === MANIFEST_FILE)
  if (manifest) await publishFile(slug, directory, manifest, abortSignal)
  await put(
    blobKey(slug, META_FILE),
    JSON.stringify({ hasIcon: files.includes(ICON_FILE) }),
    {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json",
      cacheControlMaxAge: STORE_MAX_AGE,
      abortSignal,
    }
  )
}
