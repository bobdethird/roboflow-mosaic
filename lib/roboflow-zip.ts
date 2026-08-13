// Reads a Roboflow export zip over HTTP without ever putting it on disk.
//
// The export is the largest thing an ingest touches — gigabytes for a big
// dataset — and a serverless function has ~500 MB of `/tmp`, so spooling it was
// the one thing that could not scale. Nothing here writes a file: entries are
// pulled straight out of the remote zip and handed to the caller as buffers.
//
// Two ways in, and the difference matters for large datasets:
//
//   1. `readZipIndex` reads the zip's central directory with a couple of range
//      requests, so the caller learns every image entry (name, offset, size)
//      before a single image byte moves. It can then read *only* the entries it
//      wants — a stride across a 500k-image export costs a fraction of the
//      export's bytes instead of all of them.
//   2. `streamZipEntries` is the fallback for a host that ignores `Range`. It
//      walks one sequential response, so entries arrive in zip order and the
//      whole export crosses the wire whether or not the caller keeps each one.
//
// Both paths cap what they hold: one window of compressed bytes per in-flight
// read.
//
// Parsing the format itself — the end-of-central-directory record, Zip64, the
// central directory's records, local headers — lives in lib/zip-format.ts and
// is shared with the reader for the published library archive. What is here is
// everything specific to reading a large export over HTTP.

import { Unzip, UnzipInflate, type UnzipFile } from "fflate"

import { EvenSample, isImageEntryName } from "./roboflow-sample"
import {
  EOCD_SEARCH_BYTES,
  LOCAL_HEADER_FIXED,
  ZipReadError,
  expandEntry,
  localDataOffset,
  locateCentralDirectory,
  parseDirectoryWindow,
  type ZipEntry,
} from "./zip-format"

export { ZipReadError, type ZipEntry } from "./zip-format"
export { EvenSample, isImageEntryName } from "./roboflow-sample"

// Central-directory records are read in windows rather than in one buffer: the
// directory of a million-entry export is tens of megabytes.
const DIRECTORY_WINDOW = 4 * 1024 * 1024
// One ranged read may cover several entries. Reading a little dead space between
// them beats paying for another request; reading a lot does not.
//
// This is also what the ingest's memory footprint is made of, since a window is
// held while the entries inside it are decoded: this times the read concurrency,
// and nothing to do with how large the export is. Bigger windows mean fewer
// requests for the same bytes, which stops mattering well below this size.
export const READ_WINDOW = 4 * 1024 * 1024
const MERGE_GAP = 128 * 1024
// The local header repeats the entry name and may carry a different extra
// field than the central directory did, so a coalesced read leaves this much
// slack for it. A larger local header just costs one extra request.
const LOCAL_EXTRA_SLACK = 512
// An entry that expands beyond this is not a dataset image; refuse it rather
// than inflate a zip bomb into the function's memory.
const MAX_ENTRY_BYTES = 64 * 1024 * 1024

// The host answered a ranged request with the whole body. Random access is off
// the table for this URL; the caller falls back to a sequential read.
class RangeUnsupportedError extends ZipReadError {}

export type ZipIndex = {
  // Image entries, in central-directory order. Evenly thinned when the export
  // holds more images than `maxEntries` (see `EvenSample`).
  entries: ZipEntry[]
  // Image entries the central directory actually listed, before thinning.
  imageCount: number
  // 1 when every image entry is present, 2 when every other one is, and so on.
  stride: number
}

export type ZipVisitor = (entry: ZipEntry, bytes: Buffer) => Promise<void>

// ─── Ranged reads ────────────────────────────────────────────────────────────

type RangeResult = { bytes: Buffer; totalSize: number }

function parseTotalSize(header: string | null): number {
  // "bytes 1000-1999/12345"
  const total = header?.split("/")[1]?.trim()
  const size = total && total !== "*" ? Number(total) : NaN
  return Number.isFinite(size) ? size : 0
}

// Read a response of known length into one buffer.
//
// `arrayBuffer()` collects the chunks and then concatenates them, so it holds the
// body twice at the moment it finishes. Several of those overlap during an ingest
// and the garbage they leave is the largest thing the process would hold, so the
// bytes go straight into a buffer of the size that was asked for instead.
async function readBody(
  response: Response,
  limit: number,
  // Where to put them. A caller that reads windows over and over supplies the
  // same buffer each time rather than leaving the allocator to churn megabytes.
  into?: Buffer
): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length") ?? NaN)
  const expected = Number.isFinite(declared) ? Math.min(declared, limit) : limit
  if (!response.body || expected <= 0) {
    await response.body?.cancel().catch(() => undefined)
    return Buffer.alloc(0)
  }

  const bytes =
    into && into.length >= expected
      ? into.subarray(0, expected)
      : Buffer.allocUnsafe(expected)
  let filled = 0
  const reader = response.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      // A host answering with more than it was asked for is not one this can
      // read from safely; the alternative is growing a buffer without a bound.
      if (filled + value.length > bytes.length) {
        throw new ZipReadError(
          "The export host returned more than the requested range."
        )
      }
      bytes.set(value, filled)
      filled += value.length
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  return filled === bytes.length ? bytes : bytes.subarray(0, filled)
}

async function fetchRange(
  url: string,
  range: string,
  limit: number,
  signal?: AbortSignal,
  into?: Buffer
): Promise<RangeResult> {
  const response = await fetch(url, {
    headers: { range },
    cache: "no-store",
    signal,
  })
  if (response.status !== 206) {
    await response.body?.cancel().catch(() => undefined)
    if (response.ok) {
      throw new RangeUnsupportedError(
        `The export host ignored a range request (${response.status}).`
      )
    }
    throw new ZipReadError(
      `Reading the export failed (${response.status} ${response.statusText}).`
    )
  }
  return {
    bytes: await readBody(response, limit, into),
    totalSize: parseTotalSize(response.headers.get("content-range")),
  }
}

function fetchSpan(
  url: string,
  start: number,
  length: number,
  signal?: AbortSignal,
  into?: Buffer
): Promise<RangeResult> {
  return fetchRange(
    url,
    `bytes=${start}-${start + length - 1}`,
    length,
    signal,
    into
  )
}

// ─── Central directory ───────────────────────────────────────────────────────

type Eocd = { directoryOffset: number; directorySize: number }

async function readEocd(
  url: string,
  signal?: AbortSignal
): Promise<{ eocd: Eocd; totalSize: number }> {
  // A suffix range asks for the last N bytes without knowing the total size.
  const { bytes: tail, totalSize } = await fetchRange(
    url,
    `bytes=-${EOCD_SEARCH_BYTES}`,
    EOCD_SEARCH_BYTES,
    signal
  )
  const { offset, size } = await locateCentralDirectory(
    tail,
    Math.max(0, totalSize - tail.length),
    async (start, end) =>
      (await fetchSpan(url, start, end - start + 1, signal)).bytes
  )
  return {
    eocd: { directoryOffset: offset, directorySize: size },
    totalSize,
  }
}

// The images in a directory window, in order. Directories, sidecar labels and
// anything stored with a compression method we cannot expand are not tiles.
function onImageEntry(sample: EvenSample<ZipEntry>): (entry: ZipEntry) => void {
  return (entry) => {
    if (entry.name.endsWith("/") || !isImageEntryName(entry.name)) return
    if (entry.method !== 0 && entry.method !== 8) return
    sample.push(entry)
  }
}

export type IndexOptions = {
  // Ceiling on indexed image entries. A larger export is thinned evenly rather
  // than held whole — the point of the index is choosing what to read, and a
  // million entries of metadata is itself a memory problem.
  maxEntries: number
  signal?: AbortSignal
}

// Every image entry in the remote zip, or null when the host will not serve
// ranges (or the archive's directory cannot be read, which is the same problem
// for the caller: fall back to a sequential read).
export async function readZipIndex(
  url: string,
  options: IndexOptions
): Promise<ZipIndex | null> {
  try {
    const { eocd, totalSize } = await readEocd(url, options.signal)
    if (
      !eocd.directorySize ||
      eocd.directoryOffset + eocd.directorySize > (totalSize || Infinity)
    ) {
      throw new ZipReadError(
        "The export zip's central directory is out of range."
      )
    }

    const sample = new EvenSample<ZipEntry>(options.maxEntries)
    const keep = onImageEntry(sample)
    let carry: Buffer<ArrayBufferLike> = Buffer.alloc(0)
    let read = 0
    while (read < eocd.directorySize) {
      const length = Math.min(DIRECTORY_WINDOW, eocd.directorySize - read)
      const { bytes } = await fetchSpan(
        url,
        eocd.directoryOffset + read,
        length,
        options.signal
      )
      if (!bytes.length) break
      read += bytes.length
      const buffer = carry.length ? Buffer.concat([carry, bytes]) : bytes
      const window = parseDirectoryWindow(buffer, keep)
      if (window.done) break
      carry = buffer.subarray(window.consumed)
    }

    // An index with no images is still an index: the export really does not
    // contain any, which is a different failure from not being able to read it.
    return {
      entries: sample.items,
      imageCount: sample.total,
      stride: sample.stride,
    }
  } catch (error) {
    if (error instanceof ZipReadError) return null
    // A network or abort failure is the caller's to handle, not something a
    // sequential retry would fix.
    throw error
  }
}

// ─── Reading entries by range ────────────────────────────────────────────────

// Upper bound of where an entry's compressed data can end, given only what the
// central directory said about it.
function entryEnd(entry: ZipEntry): number {
  return (
    entry.offset +
    LOCAL_HEADER_FIXED +
    Buffer.byteLength(entry.name, "utf8") +
    LOCAL_EXTRA_SLACK +
    entry.compressedSize
  )
}

type ReadGroup = { start: number; end: number; entries: ZipEntry[] }

// Bundle entries that sit near each other into one ranged read. Sampled entries
// are usually far apart (one request each); a dense read of a small export
// collapses into a handful of requests.
export function planReadGroups(entries: ZipEntry[]): ReadGroup[] {
  const ordered = [...entries].sort((a, b) => a.offset - b.offset)
  const groups: ReadGroup[] = []
  for (const entry of ordered) {
    const end = entryEnd(entry)
    const current = groups[groups.length - 1]
    if (
      current &&
      entry.offset - current.end <= MERGE_GAP &&
      end - current.start <= READ_WINDOW
    ) {
      current.end = Math.max(current.end, end)
      current.entries.push(entry)
      continue
    }
    groups.push({ start: entry.offset, end, entries: [entry] })
  }
  return groups
}

// Slice one entry's compressed bytes out of a window that covers it, re-reading
// precisely when its local header turned out to be longer than the slack the
// window allowed for.
async function entryBytes(
  url: string,
  entry: ZipEntry,
  window: { start: number; bytes: Buffer },
  signal?: AbortSignal
): Promise<Buffer> {
  const at = entry.offset - window.start
  if (at < 0) throw new ZipReadError(`Short read for ${entry.name}.`)
  const dataStart = at + localDataOffset(window.bytes, at, entry.name)
  const dataEnd = dataStart + entry.compressedSize
  if (dataEnd <= window.bytes.length) {
    return window.bytes.subarray(dataStart, dataEnd)
  }
  const { bytes } = await fetchSpan(
    url,
    window.start + dataStart,
    entry.compressedSize,
    signal
  )
  return bytes
}

export type RangeReadOptions = {
  concurrency: number
  signal?: AbortSignal
  // Stop before starting another read. Already-started reads still finish.
  stop?: () => boolean
  // One entry the archive lied about, or one corrupt image, is not a reason to
  // abandon the other twenty thousand. Without a handler, such an entry fails
  // the whole read.
  onEntryError?: (entry: ZipEntry, error: unknown) => void
}

// Read the given entries — and nothing else in the archive — handing each one's
// bytes to `visit`. Order is not preserved: reads run in parallel.
export async function readZipEntries(
  url: string,
  entries: ZipEntry[],
  visit: ZipVisitor,
  options: RangeReadOptions
): Promise<void> {
  const groups = planReadGroups(entries)
  let next = 0
  let failure: unknown = null

  // A window covers many entries, so losing one to a blip loses all of them.
  const fetchWindow = async (
    group: ReadGroup,
    into: Buffer
  ): Promise<Buffer> => {
    const length = group.end - group.start
    try {
      const { bytes } = await fetchSpan(
        url,
        group.start,
        length,
        options.signal,
        into
      )
      return bytes
    } catch (error) {
      if (options.signal?.aborted) throw error
      const { bytes } = await fetchSpan(
        url,
        group.start,
        length,
        options.signal,
        into
      )
      return bytes
    }
  }

  const worker = async () => {
    // One window per worker for the whole read. A worker holds its window while
    // it decodes the entries inside it and does not refill it until they are
    // done, so this is the read's entire footprint: concurrency × READ_WINDOW,
    // whatever the export's size. An entry too large for a shared window (a
    // single image bigger than one) gets a buffer of its own.
    const window = Buffer.allocUnsafe(READ_WINDOW)
    while (failure === null) {
      if (options.stop?.()) return
      const index = next++
      if (index >= groups.length) return
      const group = groups[index]
      try {
        const read = {
          start: group.start,
          bytes: await fetchWindow(group, window),
        }
        for (const entry of group.entries) {
          if (failure !== null) return
          try {
            const compressed = await entryBytes(
              url,
              entry,
              read,
              options.signal
            )
            await visit(
              entry,
              await expandEntry(entry, compressed, MAX_ENTRY_BYTES)
            )
          } catch (error) {
            if (!options.onEntryError || options.signal?.aborted) throw error
            options.onEntryError(entry, error)
          }
        }
      } catch (error) {
        failure ??= error
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.max(1, Math.min(options.concurrency, groups.length)) },
      worker
    )
  )
  if (failure !== null) throw failure
}

// ─── Sequential read ─────────────────────────────────────────────────────────

export type StreamOptions = {
  // Which entries to keep. Everything else is discarded as it goes past — a
  // sequential read pays for the whole export either way.
  want: (entry: ZipEntry) => boolean
  concurrency: number
  signal?: AbortSignal
  stop?: () => boolean
  // Compressed bytes pulled off the wire so far, for progress reporting.
  onProgress?: (received: number, total: number) => void
}

// Raised at whatever entry a stopped read was in the middle of. Not a failure:
// the caller asked to stop, and a half-collected entry is simply dropped.
class StreamStopped extends Error {}

function collectEntry(
  file: UnzipFile,
  keep: boolean,
  // Rejecters for entries still arriving, so a stop settles them instead of
  // leaving the read waiting for chunks that were cancelled.
  inflight: Set<(reason: Error) => void>
): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let length = 0
    const settle = (run: () => void) => {
      inflight.delete(reject)
      run()
    }
    inflight.add(reject)
    file.ondata = (error, chunk, final) => {
      if (error) {
        settle(() => reject(error))
        return
      }
      if (keep && chunk.length) {
        length += chunk.length
        if (length > MAX_ENTRY_BYTES) {
          settle(() =>
            reject(new ZipReadError(`${file.name} is implausibly large.`))
          )
          return
        }
        chunks.push(Buffer.from(chunk))
      }
      if (final) {
        settle(() => resolve(keep ? Buffer.concat(chunks, length) : null))
      }
    }
    try {
      // Every entry is started, wanted or not: fflate buffers the bytes of an
      // entry nobody started, so declining one costs memory rather than saving
      // work.
      file.start()
    } catch (error) {
      settle(() => reject(error))
    }
  })
}

// Walk the export in one pass, without random access. Entries arrive in zip
// order; `want` decides which ones reach `visit`.
export async function streamZipEntries(
  url: string,
  visit: ZipVisitor,
  options: StreamOptions
): Promise<void> {
  const response = await fetch(url, {
    cache: "no-store",
    signal: options.signal,
  })
  if (!response.ok || !response.body) {
    throw new ZipReadError(
      `Downloading the dataset export failed (${response.status} ${response.statusText}).`
    )
  }
  const total = Number(response.headers.get("content-length") ?? 0)

  const pending = new Set<Promise<void>>()
  const inflight = new Set<(reason: Error) => void>()
  let failure: unknown = null
  let stopped = false

  const track = (task: Promise<void>) => {
    const tracked = task
      .catch((error: unknown) => {
        if (!(error instanceof StreamStopped)) failure ??= error
      })
      .finally(() => {
        pending.delete(tracked)
      })
    pending.add(tracked)
  }

  const unzip = new Unzip((file) => {
    if (failure !== null || stopped) return
    const entry: ZipEntry = {
      name: file.name,
      offset: 0,
      compressedSize: file.size ?? 0,
      uncompressedSize: file.originalSize ?? 0,
      method: file.compression,
    }
    const keep =
      !file.name.endsWith("/") &&
      isImageEntryName(file.name) &&
      options.want(entry)
    track(
      collectEntry(file, keep, inflight).then(async (bytes) => {
        if (bytes && failure === null && !stopped) await visit(entry, bytes)
      })
    )
  })
  unzip.register(UnzipInflate)

  const reader = response.body.getReader()
  let received = 0
  try {
    for (;;) {
      if (failure !== null) break
      if (options.stop?.()) {
        stopped = true
        break
      }
      // Hold the read loop while the pool is busy: chunks arrive faster than
      // images can be re-encoded, and the difference is memory.
      while (pending.size >= options.concurrency && failure === null) {
        await Promise.race(pending)
      }
      const { done, value } = await reader.read()
      if (done) break
      received += value.length
      options.onProgress?.(received, total)
      unzip.push(value)
    }
    if (failure === null && !stopped) {
      unzip.push(new Uint8Array(), true)
    } else {
      // No more chunks are coming, so entries mid-flight would wait forever.
      await reader.cancel().catch(() => undefined)
      for (const abandon of [...inflight]) {
        abandon(new StreamStopped("The export read was stopped."))
      }
    }
    while (pending.size) await Promise.race(pending)
    if (failure !== null) throw failure
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}
