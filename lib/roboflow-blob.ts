// Durable copy of an ingested dataset, for serverless hosts.
//
// The library is built on local disk the same way it always was. A Vercel
// instance cannot keep that directory, so the finished library is packed into
// one zip and uploaded once. The next instance that needs a file downloads
// that zip into its own cache directory and serves from there — ingest stays
// a single upload instead of one HTTP PUT per thumbnail.

import { head, put } from "@vercel/blob"
import { createReadStream, createWriteStream } from "node:fs"
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises"
import path from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import yauzl from "yauzl"
import { ZipFile } from "yazl"

import { ICON_FILE, MANIFEST_FILE, type IngestStatus } from "./roboflow"
import { STATUS_FILE, datasetDir, type ProgressReporter } from "./roboflow-store"

const PREFIX = "roboflow"
export const ARCHIVE_FILE = "library.zip"
const META_FILE = "published.json"

// Thumbnails are already JPEG; deflating them only burns CPU.
const STORE_MAX_AGE = 60

const SKIP_DIRS = new Set(["source"])
const SKIP_FILES = new Set([
  STATUS_FILE,
  "export.zip",
  ARCHIVE_FILE,
  META_FILE,
])

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
    const response = await fetch(meta.url, { cache: "no-store" })
    return response.ok ? await response.text() : null
  } catch {
    return null
  }
}

export async function readBlobStatus(slug: string): Promise<IngestStatus | null> {
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
// shared. No CDN cache: the page reads this every 700ms.
export async function writeBlobStatus(
  slug: string,
  status: IngestStatus
): Promise<void> {
  await put(blobKey(slug, STATUS_FILE), JSON.stringify(status), {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
    cacheControlMaxAge: 0,
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

function packZip(
  directory: string,
  files: string[],
  destination: string,
  report: ProgressReporter
): Promise<void> {
  return new Promise((resolve, reject) => {
    const zipfile = new ZipFile()
    const output = createWriteStream(destination)
    zipfile.outputStream.pipe(output)
    output.on("close", resolve)
    output.on("error", reject)
    zipfile.outputStream.on("error", reject)

    for (let i = 0; i < files.length; i++) {
      zipfile.addFile(path.join(directory, files[i]), files[i], {
        compress: false,
      })
      report("Packing library", i + 1, files.length)
    }
    zipfile.end()
  })
}

function openZip(file: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: true }, (error, zip) => {
      if (error || !zip) {
        reject(error ?? new Error("Could not open the library archive."))
      } else resolve(zip)
    })
  })
}

async function extractZip(zipPath: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true })
  const zip = await openZip(zipPath)

  await new Promise<void>((resolve, reject) => {
    zip.on("entry", (entry: yauzl.Entry) => {
      const relative = entry.fileName.replace(/\\/g, "/")
      if (
        entry.fileName.endsWith("/") ||
        relative.includes("..") ||
        path.isAbsolute(relative)
      ) {
        zip.readEntry()
        return
      }
      zip.openReadStream(entry, (error, stream) => {
        if (error || !stream) {
          reject(error ?? new Error(`Could not read ${entry.fileName}`))
          return
        }
        const target = path.join(destination, ...relative.split("/"))
        void mkdir(path.dirname(target), { recursive: true })
          .then(() => pipeline(stream, createWriteStream(target)))
          .then(() => zip.readEntry())
          .catch(reject)
      })
    })
    zip.on("end", resolve)
    zip.on("error", reject)
    zip.readEntry()
  })
}

async function downloadBlob(slug: string, relativePath: string, destination: string) {
  const meta = await head(blobKey(slug, relativePath))
  const response = await fetch(meta.url, { cache: "no-store" })
  if (!response.ok || !response.body) {
    throw new Error(`Downloading ${relativePath} failed (${response.status}).`)
  }
  await pipeline(
    Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
    createWriteStream(destination)
  )
}

async function hasLocalLibrary(slug: string): Promise<boolean> {
  try {
    const dir = datasetDir(slug)
    await stat(path.join(dir, MANIFEST_FILE))
    const thumbs = await readdir(path.join(dir, "thumbs"))
    return thumbs.length > 0
  } catch {
    return false
  }
}

const hydrating = new Map<string, Promise<void>>()

async function hydrate(slug: string): Promise<void> {
  const dir = datasetDir(slug)
  await mkdir(dir, { recursive: true })
  const zipPath = path.join(dir, ARCHIVE_FILE)
  try {
    await downloadBlob(slug, ARCHIVE_FILE, zipPath)
    await extractZip(zipPath, dir)
  } finally {
    await rm(zipPath, { force: true })
  }
  if (await blobHasFile(slug, ICON_FILE)) {
    await downloadBlob(slug, ICON_FILE, path.join(dir, ICON_FILE))
  }
}

// Make sure this instance has the dataset on disk, downloading the published
// archive if this process did not run the ingest.
export async function ensureLocalDataset(slug: string): Promise<void> {
  if (!blobEnabled()) return
  if (await hasLocalLibrary(slug)) return
  const pending = hydrating.get(slug)
  if (pending) {
    await pending
    return
  }
  const job = hydrate(slug).finally(() => {
    if (hydrating.get(slug) === job) hydrating.delete(slug)
  })
  hydrating.set(slug, job)
  await job
}

export async function publishFile(
  slug: string,
  directory: string,
  relativePath: string
): Promise<void> {
  const body = await readFile(path.join(directory, relativePath))
  await put(blobKey(slug, relativePath), body, {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: STORE_MAX_AGE,
  })
}

export async function publishDataset(
  slug: string,
  directory: string,
  report: ProgressReporter
): Promise<void> {
  const files = await libraryFiles(directory)
  if (!files.length) {
    throw new Error("Nothing to publish — the library was empty.")
  }

  const zipPath = path.join(directory, ARCHIVE_FILE)
  try {
    await packZip(directory, files, zipPath, report)
    report("Uploading library", 0, 0)
    await put(blobKey(slug, ARCHIVE_FILE), createReadStream(zipPath), {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/zip",
      cacheControlMaxAge: STORE_MAX_AGE,
      multipart: true,
      onUploadProgress: (event) => {
        report("Uploading library", event.loaded, event.total)
      },
    })
  } finally {
    await rm(zipPath, { force: true })
  }

  const manifest = files.find((file) => file === MANIFEST_FILE)
  if (manifest) await publishFile(slug, directory, manifest)
  await put(
    blobKey(slug, META_FILE),
    JSON.stringify({ hasIcon: files.includes(ICON_FILE) }),
    {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json",
      cacheControlMaxAge: STORE_MAX_AGE,
    }
  )
}
