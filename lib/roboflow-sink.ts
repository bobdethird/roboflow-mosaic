// Where a built tile library goes.
//
// The browser wants the whole library as one zip (lib/roboflow-pack.ts) and it
// gets exactly that either way — a sink is only about how that archive is
// produced. Neither implementation needs room for the finished library:
//
//   • `blobArchiveSink` zips each file as it is produced and pushes the bytes to
//     Blob as multipart parts, holding one part in memory. Nothing is staged on
//     disk, which is what lets a serverless ingest outgrow its ~500 MB `/tmp`.
//   • `directorySink` writes the files into the local cache directory, which is
//     what local development reads and re-zips on demand.
//
// Files arrive in whatever order they were produced, and the manifest and
// signature blob go in last because their contents are only known then. The
// client parses the archive incrementally and waits for every entry, so where
// each file sits inside the zip does not matter to it.

import { mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import type { Readable } from "node:stream"

import { createMultipartUploader, put, type Part } from "@vercel/blob"
import { ZipFile } from "yazl"

import { ICON_FILE, MANIFEST_FILE } from "./roboflow"
import {
  ARCHIVE_FILE,
  PUBLISHED_FILE,
  STORE_MAX_AGE,
  blobKey,
} from "./roboflow-blob"

// Blob requires every multipart part except the last to be at least 5 MB.
// Eight keeps the request count low without holding much.
export const PART_BYTES = 8 * 1024 * 1024
// Parts in flight. More would only help if the upload were the bottleneck; it is
// not — re-encoding the images is.
const PART_CONCURRENCY = 2
// yazl writes an entry a tick after it is added, so a burst of adds can queue
// inside it. Past this much unwritten, `add` waits for it to catch up.
const MAX_UNWRITTEN_BYTES = 32 * 1024 * 1024

export type LibrarySink = {
  // Add one file to the library under `name`, a path inside the archive.
  add: (name: string, bytes: Buffer) => Promise<void>
  // Close the library out. Nothing is readable until this resolves.
  finish: () => Promise<void>
  // Give up without leaving a half-built library behind.
  abort: () => Promise<void>
}

// ─── Local cache directory ───────────────────────────────────────────────────

export async function directorySink(directory: string): Promise<LibrarySink> {
  await mkdir(directory, { recursive: true })
  // A re-ingest can produce fewer thumbnails than the last one did, and the
  // local pack route zips whatever is in the directory, so stale files would
  // otherwise ride along in every later download.
  await rm(path.join(directory, "thumbs"), { recursive: true, force: true })
  await mkdir(path.join(directory, "thumbs"), { recursive: true })

  return {
    add: async (name, bytes) => {
      await writeFile(path.join(directory, name), bytes)
    },
    finish: async () => {},
    abort: async () => {},
  }
}

// ─── Streamed Blob archive ───────────────────────────────────────────────────

// Pull `count` bytes off the front of a chunk queue without copying the rest.
function takeBytes(queue: Buffer[], count: number): Buffer {
  const taken: Buffer[] = []
  let remaining = count
  while (remaining > 0) {
    const head = queue[0]
    if (head.length <= remaining) {
      taken.push(head)
      remaining -= head.length
      queue.shift()
      continue
    }
    taken.push(head.subarray(0, remaining))
    queue[0] = head.subarray(remaining)
    remaining = 0
  }
  return taken.length === 1 ? taken[0] : Buffer.concat(taken, count)
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

// The half of a multipart upload this module drives. Narrower than Blob's
// uploader so the archive assembly can be exercised without a store.
export type PartUploader = {
  uploadPart: (partNumber: number, body: Buffer) => Promise<Part>
  complete: (parts: Part[]) => Promise<unknown>
}

export type MultipartSinkOptions = {
  // Runs once the archive is complete, with every name it contains.
  onComplete?: (names: Set<string>) => Promise<void>
}

// One dataset library, zipped and uploaded part by part as it is built. Peak
// memory is a part plus whatever yazl has not yet written, no matter how big the
// library grows.
export function multipartArchiveSink(
  uploader: PartUploader,
  options: MultipartSinkOptions = {}
): LibrarySink {
  const zip = new ZipFile()
  // @types/yazl declares the minimal NodeJS interface, but this is a
  // stream.PassThrough at runtime.
  const stream = zip.outputStream as Readable
  const queue: Buffer[] = []
  const uploads = new Set<Promise<void>>()
  const parts: Part[] = []
  const names = new Set<string>()
  let queuedBytes = 0
  let addedBytes = 0
  let writtenBytes = 0
  let partNumber = 0
  let failure: unknown = null
  let closed = false

  // yazl emits into this stream as entries are pumped, so collecting the chunks
  // here is what keeps memory to one part rather than one library.
  stream.on("data", (chunk: Buffer) => {
    queue.push(chunk)
    queuedBytes += chunk.length
    writtenBytes += chunk.length
  })
  const ended = new Promise<void>((resolve, reject) => {
    stream.on("end", resolve)
    stream.on("error", reject)
  })
  // An abort never awaits `ended`, and a rejection nobody is waiting on takes
  // the process down.
  ended.catch(() => undefined)

  const startPart = (body: Buffer) => {
    const number = ++partNumber
    const upload = uploader
      .uploadPart(number, body)
      .then((part) => {
        parts.push(part)
      })
      .catch((error: unknown) => {
        failure ??= error
      })
    const tracked = upload.finally(() => {
      uploads.delete(tracked)
    })
    uploads.add(tracked)
  }

  const flush = async (final: boolean): Promise<void> => {
    for (;;) {
      if (failure) throw failure
      const take =
        queuedBytes >= PART_BYTES ? PART_BYTES : final ? queuedBytes : 0
      if (!take) return
      startPart(takeBytes(queue, take))
      queuedBytes -= take
      while (uploads.size >= PART_CONCURRENCY) await Promise.race(uploads)
    }
  }

  return {
    add: async (name, bytes) => {
      if (closed) throw new Error("The library archive is already closed.")
      if (failure) throw failure
      // The client keeps the last entry it sees for a name, so a repeat would
      // only be wasted bytes.
      if (names.has(name)) return
      names.add(name)
      addedBytes += bytes.length
      // Thumbnails and the cover are already JPEG and the signature blob is
      // dense: deflating them burns CPU for nothing, and stored entries are
      // cheaper for the browser to unpack.
      zip.addBuffer(bytes, name, { compress: false })
      while (addedBytes - writtenBytes > MAX_UNWRITTEN_BYTES) await tick()
      await flush(false)
    },
    finish: async () => {
      closed = true
      zip.end()
      await ended
      await flush(true)
      while (uploads.size) await Promise.race(uploads)
      if (failure) throw failure
      // Blob rejects an upload with no parts, and an empty archive is not a
      // library anyway.
      if (!parts.length) {
        throw new Error("The library archive came out empty.")
      }
      await uploader.complete(
        [...parts].sort((a, b) => a.partNumber - b.partNumber)
      )
      await options.onComplete?.(names)
    },
    abort: async () => {
      closed = true
      queue.length = 0
      queuedBytes = 0
      stream.destroy()
      // The parts uploaded so far are never completed into a blob, so they
      // cannot be mistaken for a finished library.
      await Promise.allSettled([...uploads])
    },
  }
}

// The library for `slug`, streamed into the Blob store as one archive.
export async function blobArchiveSink(
  slug: string,
  options: { abortSignal?: AbortSignal } = {}
): Promise<LibrarySink> {
  const { abortSignal } = options
  const uploader = await createMultipartUploader(blobKey(slug, ARCHIVE_FILE), {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/zip",
    cacheControlMaxAge: STORE_MAX_AGE,
    abortSignal,
  })

  return multipartArchiveSink(
    {
      uploadPart: (partNumber, body) => uploader.uploadPart(partNumber, body),
      complete: (parts) => uploader.complete(parts),
    },
    {
      onComplete: async (names) => {
        // Recorded next to the archive so an instance that never built this
        // dataset can still answer whether it has a cover image, without
        // fetching the archive to look.
        await put(
          blobKey(slug, PUBLISHED_FILE),
          JSON.stringify({ hasIcon: names.has(ICON_FILE) }),
          {
            access: "public",
            addRandomSuffix: false,
            allowOverwrite: true,
            contentType: "application/json",
            cacheControlMaxAge: STORE_MAX_AGE,
            abortSignal,
          }
        )
      },
    }
  )
}

// The manifest is published on its own as well as inside the archive: the poll
// route rebuilds a dataset record from it when a status file has gone, and
// downloading a whole library to read one JSON file would be absurd.
export async function publishManifest(
  slug: string,
  manifest: Buffer,
  abortSignal?: AbortSignal
): Promise<void> {
  await put(blobKey(slug, MANIFEST_FILE), manifest, {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
    cacheControlMaxAge: STORE_MAX_AGE,
    abortSignal,
  })
}
