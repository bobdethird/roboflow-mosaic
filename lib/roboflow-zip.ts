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

import { promisify } from "node:util"
import { inflateRaw as inflateRawCallback } from "node:zlib"

import { Unzip, UnzipInflate, type UnzipFile } from "fflate"

const inflateRaw = promisify(inflateRawCallback)

const LOCAL_SIG = 0x04034b50
const CENTRAL_SIG = 0x02014b50
const EOCD_SIG = 0x06054b50
const EOCD64_SIG = 0x06064b50
const EOCD64_LOCATOR_SIG = 0x07064b58

const LOCAL_HEADER_FIXED = 30
const CENTRAL_HEADER_FIXED = 46
const EOCD_FIXED = 22
// A zip comment can be 64 KB, and the end-of-central-directory record sits
// before it, so this is the largest tail worth scanning for the record.
const EOCD_SEARCH_BYTES = 64 * 1024 + EOCD_FIXED + 20
// Central-directory records are read in windows rather than in one buffer: the
// directory of a million-entry export is tens of megabytes.
const DIRECTORY_WINDOW = 4 * 1024 * 1024
// One ranged read may cover several entries. Reading a little dead space between
// them beats paying for another request; reading a lot does not.
const READ_WINDOW = 16 * 1024 * 1024
const MERGE_GAP = 256 * 1024
// The local header repeats the entry name and may carry a different extra
// field than the central directory did, so a coalesced read leaves this much
// slack for it. A larger local header just costs one extra request.
const LOCAL_EXTRA_SLACK = 512
// An entry that expands beyond this is not a dataset image; refuse it rather
// than inflate a zip bomb into the function's memory.
const MAX_ENTRY_BYTES = 64 * 1024 * 1024

const IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".bmp",
  ".tif",
  ".tiff",
  ".avif",
])

export class ZipReadError extends Error {}

// The host answered a ranged request with the whole body. Random access is off
// the table for this URL; the caller falls back to a sequential read.
class RangeUnsupportedError extends ZipReadError {}

export function isImageEntryName(name: string): boolean {
  const dot = name.lastIndexOf(".")
  if (dot < 0) return false
  return IMAGE_EXTENSIONS.has(name.slice(dot).toLowerCase())
}

export type ZipEntry = {
  name: string
  // Offset of the entry's local file header in the archive.
  offset: number
  compressedSize: number
  uncompressedSize: number
  // 0 stored, 8 deflate. Anything else is skipped while indexing.
  method: number
}

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

// Keeps at most `cap` items, spread evenly across an unknown-length sequence:
// once full it drops every other item it kept and doubles its stride, so the
// survivors stay evenly spaced no matter how much more arrives. Used while
// parsing a central directory, whose image count is only known once it has been
// read — and which is too large to keep whole for a million-image export.
export class EvenSample<T> {
  private kept: T[] = []
  private seen = 0
  private step = 1

  constructor(private readonly cap: number) {
    if (cap < 1) throw new ZipReadError("Sample cap must be at least one.")
  }

  push(item: T): void {
    const index = this.seen++
    if (index % this.step !== 0) return
    this.kept.push(item)
    if (this.kept.length <= this.cap) return
    // Halve in place: indices 0, 2, 4 … of the kept list are still multiples of
    // the doubled stride in the original sequence.
    let write = 0
    for (let read = 0; read < this.kept.length; read += 2) {
      this.kept[write++] = this.kept[read]
    }
    this.kept.length = write
    this.step *= 2
  }

  get items(): T[] {
    return this.kept
  }

  get total(): number {
    return this.seen
  }

  get stride(): number {
    return this.step
  }
}

// ─── Ranged reads ────────────────────────────────────────────────────────────

type RangeResult = { bytes: Buffer; totalSize: number }

function parseTotalSize(header: string | null): number {
  // "bytes 1000-1999/12345"
  const total = header?.split("/")[1]?.trim()
  const size = total && total !== "*" ? Number(total) : NaN
  return Number.isFinite(size) ? size : 0
}

async function fetchRange(
  url: string,
  range: string,
  signal?: AbortSignal
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
    bytes: Buffer.from(await response.arrayBuffer()),
    totalSize: parseTotalSize(response.headers.get("content-range")),
  }
}

function fetchSpan(
  url: string,
  start: number,
  length: number,
  signal?: AbortSignal
): Promise<RangeResult> {
  return fetchRange(url, `bytes=${start}-${start + length - 1}`, signal)
}

// ─── Central directory ───────────────────────────────────────────────────────

function readU64(bytes: Buffer, at: number): number {
  const value = bytes.readBigUInt64LE(at)
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ZipReadError("The export zip declares an implausible size.")
  }
  return Number(value)
}

type Eocd = { directoryOffset: number; directorySize: number }

function findEocd(tail: Buffer): number {
  for (let at = tail.length - EOCD_FIXED; at >= 0; at--) {
    if (tail.readUInt32LE(at) !== EOCD_SIG) continue
    const commentLength = tail.readUInt16LE(at + 20)
    if (at + EOCD_FIXED + commentLength === tail.length) return at
  }
  throw new ZipReadError(
    "The export zip has no end-of-central-directory record."
  )
}

async function readEocd(
  url: string,
  signal?: AbortSignal
): Promise<{ eocd: Eocd; totalSize: number }> {
  // A suffix range asks for the last N bytes without knowing the total size.
  const { bytes: tail, totalSize } = await fetchRange(
    url,
    `bytes=-${EOCD_SEARCH_BYTES}`,
    signal
  )
  const at = findEocd(tail)
  let directorySize = tail.readUInt32LE(at + 12)
  let directoryOffset = tail.readUInt32LE(at + 16)

  // Zip64: the 32-bit fields saturate and the real values live in a separate
  // record, located by a fixed-size locator right before the classic one.
  if (directoryOffset === 0xffffffff || directorySize === 0xffffffff) {
    const locator = at - 20
    if (locator < 0 || tail.readUInt32LE(locator) !== EOCD64_LOCATOR_SIG) {
      throw new ZipReadError("The export zip is missing its zip64 locator.")
    }
    const eocd64Offset = readU64(tail, locator + 8)
    const { bytes: record } = await fetchSpan(url, eocd64Offset, 56, signal)
    if (record.readUInt32LE(0) !== EOCD64_SIG) {
      throw new ZipReadError("The export zip has a malformed zip64 record.")
    }
    directorySize = readU64(record, 40)
    directoryOffset = readU64(record, 48)
  }

  return { eocd: { directoryOffset, directorySize }, totalSize }
}

// Zip64 extra field: the 8-byte values that replace whichever 32-bit fields
// saturated, in a fixed order.
function applyZip64Extra(
  extra: Buffer,
  entry: { compressedSize: number; uncompressedSize: number; offset: number },
  saturated: { compressed: boolean; uncompressed: boolean; offset: boolean }
): void {
  let at = 0
  while (at + 4 <= extra.length) {
    const id = extra.readUInt16LE(at)
    const size = extra.readUInt16LE(at + 2)
    const body = extra.subarray(at + 4, at + 4 + size)
    at += 4 + size
    if (id !== 0x0001) continue
    let read = 0
    if (saturated.uncompressed && read + 8 <= body.length) {
      entry.uncompressedSize = readU64(body, read)
      read += 8
    }
    if (saturated.compressed && read + 8 <= body.length) {
      entry.compressedSize = readU64(body, read)
      read += 8
    }
    if (saturated.offset && read + 8 <= body.length) {
      entry.offset = readU64(body, read)
    }
    return
  }
}

// Parse as many whole central-directory records as `buffer` holds. Returns how
// many bytes were consumed, so the caller can carry the remainder into the next
// window, and whether the records ran out (a record that is not a record ends
// the directory).
function parseDirectoryWindow(
  buffer: Buffer,
  onEntry: (entry: ZipEntry) => void
): { consumed: number; done: boolean } {
  let at = 0
  for (;;) {
    if (at + CENTRAL_HEADER_FIXED > buffer.length) {
      return { consumed: at, done: false }
    }
    const signature = buffer.readUInt32LE(at)
    if (signature !== CENTRAL_SIG) return { consumed: at, done: true }
    const nameLength = buffer.readUInt16LE(at + 28)
    const extraLength = buffer.readUInt16LE(at + 30)
    const commentLength = buffer.readUInt16LE(at + 32)
    const total =
      CENTRAL_HEADER_FIXED + nameLength + extraLength + commentLength
    if (at + total > buffer.length) return { consumed: at, done: false }

    const method = buffer.readUInt16LE(at + 10)
    const compressedSize = buffer.readUInt32LE(at + 20)
    const uncompressedSize = buffer.readUInt32LE(at + 24)
    const offset = buffer.readUInt32LE(at + 42)
    const nameStart = at + CENTRAL_HEADER_FIXED
    const name = buffer
      .subarray(nameStart, nameStart + nameLength)
      .toString("utf8")
    const entry: ZipEntry = {
      name,
      offset,
      compressedSize,
      uncompressedSize,
      method,
    }
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      offset === 0xffffffff
    ) {
      applyZip64Extra(
        buffer.subarray(
          nameStart + nameLength,
          nameStart + nameLength + extraLength
        ),
        entry,
        {
          compressed: compressedSize === 0xffffffff,
          uncompressed: uncompressedSize === 0xffffffff,
          offset: offset === 0xffffffff,
        }
      )
    }
    at += total
    if (name.endsWith("/") || !isImageEntryName(name)) continue
    if (entry.method !== 0 && entry.method !== 8) continue
    onEntry(entry)
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
      const window = parseDirectoryWindow(buffer, (entry) => sample.push(entry))
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

async function expand(entry: ZipEntry, compressed: Buffer): Promise<Buffer> {
  if (entry.method === 0) return compressed
  const limit = Math.min(
    MAX_ENTRY_BYTES,
    Math.max(entry.uncompressedSize + 64 * 1024, 1024 * 1024)
  )
  const expanded = await inflateRaw(compressed, { maxOutputLength: limit })
  return Buffer.from(expanded)
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
  if (at < 0 || at + LOCAL_HEADER_FIXED > window.bytes.length) {
    throw new ZipReadError(`Short read for ${entry.name}.`)
  }
  if (window.bytes.readUInt32LE(at) !== LOCAL_SIG) {
    throw new ZipReadError(`${entry.name} is not where the export said it was.`)
  }
  const nameLength = window.bytes.readUInt16LE(at + 26)
  const extraLength = window.bytes.readUInt16LE(at + 28)
  const dataStart = at + LOCAL_HEADER_FIXED + nameLength + extraLength
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
  const fetchWindow = async (group: ReadGroup): Promise<Buffer> => {
    try {
      const { bytes } = await fetchSpan(
        url,
        group.start,
        group.end - group.start,
        options.signal
      )
      return bytes
    } catch (error) {
      if (options.signal?.aborted) throw error
      const { bytes } = await fetchSpan(
        url,
        group.start,
        group.end - group.start,
        options.signal
      )
      return bytes
    }
  }

  const worker = async () => {
    while (failure === null) {
      if (options.stop?.()) return
      const index = next++
      if (index >= groups.length) return
      const group = groups[index]
      try {
        const window = { start: group.start, bytes: await fetchWindow(group) }
        for (const entry of group.entries) {
          if (failure !== null) return
          try {
            const compressed = await entryBytes(
              url,
              entry,
              window,
              options.signal
            )
            await visit(entry, await expand(entry, compressed))
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
