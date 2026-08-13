// Range-reads a remote zip in the browser (or anywhere fetch exists).
//
// Same idea as lib/roboflow-zip.ts — index the central directory, then pull
// only the entries we want — but no Node Buffer or zlib. fflate inflates
// stored/deflated entries. The URL is usually the same-origin export proxy.

import { inflateSync } from "fflate"

import { EvenSample, isImageEntryName } from "./roboflow-sample"

export class ZipReadError extends Error {}

export type ZipEntry = {
  name: string
  offset: number
  compressedSize: number
  uncompressedSize: number
  method: number
}

export type ZipIndex = {
  entries: ZipEntry[]
  imageCount: number
  stride: number
}

const EOCD_SIG = 0x06054b50
const EOCD64_SIG = 0x06064b50
const EOCD64_LOCATOR_SIG = 0x07064b50
const CENTRAL_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50

const EOCD_FIXED = 22
const EOCD64_FIXED = 56
const EOCD64_LOCATOR_FIXED = 20
const CENTRAL_HEADER_FIXED = 46
const LOCAL_HEADER_FIXED = 30
const EOCD_SEARCH_BYTES = 64 * 1024 + EOCD_FIXED + EOCD64_LOCATOR_FIXED

const UINT32_MAX = 0xffffffff
const UINT16_MAX = 0xffff
const DIRECTORY_WINDOW = 4 * 1024 * 1024
const READ_WINDOW = 4 * 1024 * 1024
const MERGE_GAP = 128 * 1024
const LOCAL_EXTRA_SLACK = 512
const MAX_ENTRY_BYTES = 64 * 1024 * 1024

const text = new TextDecoder()

function u16(bytes: Uint8Array, at: number): number {
  return bytes[at]! | (bytes[at + 1]! << 8)
}

function u32(bytes: Uint8Array, at: number): number {
  return (
    (bytes[at]! |
      (bytes[at + 1]! << 8) |
      (bytes[at + 2]! << 16) |
      (bytes[at + 3]! << 24)) >>>
    0
  )
}

function u64(bytes: Uint8Array, at: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset + at, 8)
  const value = view.getBigUint64(0, true)
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ZipReadError("The archive declares an implausible size.")
  }
  return Number(value)
}

function findEocd(tail: Uint8Array): number {
  for (let at = tail.length - EOCD_FIXED; at >= 0; at--) {
    if (u32(tail, at) !== EOCD_SIG) continue
    if (at + EOCD_FIXED + u16(tail, at + 20) === tail.length) return at
  }
  throw new ZipReadError("The archive has no end-of-central-directory record.")
}

async function locateCentralDirectory(
  tail: Uint8Array,
  tailStart: number,
  read: (start: number, end: number) => Promise<Uint8Array>
): Promise<{ offset: number; size: number }> {
  const at = findEocd(tail)
  const size = u32(tail, at + 12)
  const offset = u32(tail, at + 16)
  const saturated =
    size === UINT32_MAX ||
    offset === UINT32_MAX ||
    u16(tail, at + 10) === UINT16_MAX

  if (!saturated) return { offset, size }

  const locator = at - EOCD64_LOCATOR_FIXED
  const located =
    locator >= 0 && u32(tail, locator) === EOCD64_LOCATOR_SIG
  if (!located) {
    if (size !== UINT32_MAX && offset !== UINT32_MAX) return { offset, size }
    throw new ZipReadError("The archive is missing its zip64 locator.")
  }
  const recordAt = u64(tail, locator + 8)
  const relative = recordAt - tailStart
  const record =
    relative >= 0 && relative + EOCD64_FIXED <= tail.length
      ? tail.subarray(relative, relative + EOCD64_FIXED)
      : await read(recordAt, recordAt + EOCD64_FIXED - 1)
  if (u32(record, 0) !== EOCD64_SIG) {
    throw new ZipReadError("The archive has a malformed zip64 record.")
  }
  return { offset: u64(record, 48), size: u64(record, 40) }
}

function applyZip64Extra(
  extra: Uint8Array,
  entry: ZipEntry,
  saturated: { compressed: boolean; uncompressed: boolean; offset: boolean }
): void {
  let at = 0
  while (at + 4 <= extra.length) {
    const id = u16(extra, at)
    const size = u16(extra, at + 2)
    const body = extra.subarray(at + 4, at + 4 + size)
    at += 4 + size
    if (id !== 0x0001) continue
    let read = 0
    if (saturated.uncompressed && read + 8 <= body.length) {
      entry.uncompressedSize = u64(body, read)
      read += 8
    }
    if (saturated.compressed && read + 8 <= body.length) {
      entry.compressedSize = u64(body, read)
      read += 8
    }
    if (saturated.offset && read + 8 <= body.length) {
      entry.offset = u64(body, read)
    }
    return
  }
}

function parseDirectoryWindow(
  buffer: Uint8Array,
  onEntry: (entry: ZipEntry) => void
): { consumed: number; done: boolean } {
  let at = 0
  for (;;) {
    if (at + CENTRAL_HEADER_FIXED > buffer.length) {
      return { consumed: at, done: false }
    }
    if (u32(buffer, at) !== CENTRAL_SIG) return { consumed: at, done: true }

    const nameLength = u16(buffer, at + 28)
    const extraLength = u16(buffer, at + 30)
    const commentLength = u16(buffer, at + 32)
    const total = CENTRAL_HEADER_FIXED + nameLength + extraLength + commentLength
    if (at + total > buffer.length) return { consumed: at, done: false }

    const compressedSize = u32(buffer, at + 20)
    const uncompressedSize = u32(buffer, at + 24)
    const offset = u32(buffer, at + 42)
    const nameStart = at + CENTRAL_HEADER_FIXED
    const extraStart = nameStart + nameLength
    const entry: ZipEntry = {
      name: text.decode(buffer.subarray(nameStart, extraStart)),
      offset,
      compressedSize,
      uncompressedSize,
      method: u16(buffer, at + 10),
    }
    if (
      compressedSize === UINT32_MAX ||
      uncompressedSize === UINT32_MAX ||
      offset === UINT32_MAX
    ) {
      applyZip64Extra(buffer.subarray(extraStart, extraStart + extraLength), entry, {
        compressed: compressedSize === UINT32_MAX,
        uncompressed: uncompressedSize === UINT32_MAX,
        offset: offset === UINT32_MAX,
      })
    }
    at += total
    onEntry(entry)
  }
}

function localDataOffset(header: Uint8Array, at: number, name: string): number {
  if (at + LOCAL_HEADER_FIXED > header.length) {
    throw new ZipReadError(`Short read for ${name}.`)
  }
  if (u32(header, at) !== LOCAL_SIG) {
    throw new ZipReadError(`${name} is not where the archive said it was.`)
  }
  return LOCAL_HEADER_FIXED + u16(header, at + 26) + u16(header, at + 28)
}

function expandEntry(entry: ZipEntry, compressed: Uint8Array): Uint8Array {
  if (entry.uncompressedSize > MAX_ENTRY_BYTES) {
    throw new ZipReadError(`${entry.name} is implausibly large.`)
  }
  if (entry.method === 0) return compressed
  if (entry.method !== 8) {
    throw new ZipReadError(`Unsupported zip compression method: ${entry.method}.`)
  }
  const out = inflateSync(compressed)
  if (out.length > MAX_ENTRY_BYTES) {
    throw new ZipReadError(`${entry.name} is implausibly large.`)
  }
  return out
}

function parseTotalSize(header: string | null): number {
  const total = header?.split("/")[1]?.trim()
  const size = total && total !== "*" ? Number(total) : NaN
  return Number.isFinite(size) ? size : 0
}

async function fetchRange(
  url: string,
  range: string,
  signal?: AbortSignal
): Promise<{ bytes: Uint8Array; totalSize: number; status: number }> {
  const response = await fetch(url, {
    headers: { range },
    cache: "no-store",
    signal,
  })
  if (response.status !== 206) {
    await response.body?.cancel().catch(() => undefined)
    return {
      bytes: new Uint8Array(0),
      totalSize: 0,
      status: response.status,
    }
  }
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    totalSize: parseTotalSize(response.headers.get("content-range")),
    status: 206,
  }
}

async function fetchSpan(
  url: string,
  start: number,
  length: number,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const { bytes, status } = await fetchRange(
    url,
    `bytes=${start}-${start + length - 1}`,
    signal
  )
  if (status !== 206) {
    throw new ZipReadError(`Reading the export failed (${status}).`)
  }
  return bytes
}

export async function readZipIndex(
  url: string,
  options: { maxEntries: number; signal?: AbortSignal }
): Promise<ZipIndex | null> {
  try {
    const { bytes: tail, totalSize, status } = await fetchRange(
      url,
      `bytes=-${EOCD_SEARCH_BYTES}`,
      options.signal
    )
    if (status !== 206 || !tail.length) return null
    const dir = await locateCentralDirectory(
      tail,
      Math.max(0, totalSize - tail.length),
      (start, end) => fetchSpan(url, start, end - start + 1, options.signal)
    )
    if (!dir.size || dir.offset + dir.size > (totalSize || Infinity)) {
      throw new ZipReadError("The export zip's central directory is out of range.")
    }

    const sample = new EvenSample<ZipEntry>(options.maxEntries)
    let carry = new Uint8Array(0)
    let read = 0
    while (read < dir.size) {
      const length = Math.min(DIRECTORY_WINDOW, dir.size - read)
      const bytes = await fetchSpan(
        url,
        dir.offset + read,
        length,
        options.signal
      )
      if (!bytes.length) break
      read += bytes.length
      const buffer =
        carry.length === 0 ? bytes : concat(carry, bytes)
      const window = parseDirectoryWindow(buffer, (entry) => {
        if (entry.name.endsWith("/") || !isImageEntryName(entry.name)) return
        if (entry.method !== 0 && entry.method !== 8) return
        sample.push(entry)
      })
      if (window.done) break
      carry = concat(buffer.subarray(window.consumed), new Uint8Array(0))
    }
    return {
      entries: sample.items,
      imageCount: sample.total,
      stride: sample.stride,
    }
  } catch (error) {
    if (error instanceof ZipReadError) return null
    throw error
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

function entryEnd(entry: ZipEntry): number {
  return (
    entry.offset +
    LOCAL_HEADER_FIXED +
    new TextEncoder().encode(entry.name).length +
    LOCAL_EXTRA_SLACK +
    entry.compressedSize
  )
}

type ReadGroup = { start: number; end: number; entries: ZipEntry[] }

function planReadGroups(entries: ZipEntry[]): ReadGroup[] {
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

async function entryBytes(
  url: string,
  entry: ZipEntry,
  window: { start: number; bytes: Uint8Array },
  signal?: AbortSignal
): Promise<Uint8Array> {
  const at = entry.offset - window.start
  if (at < 0) throw new ZipReadError(`Short read for ${entry.name}.`)
  const dataStart = at + localDataOffset(window.bytes, at, entry.name)
  const dataEnd = dataStart + entry.compressedSize
  if (dataEnd <= window.bytes.length) {
    return window.bytes.subarray(dataStart, dataEnd)
  }
  return fetchSpan(url, window.start + dataStart, entry.compressedSize, signal)
}

export async function readZipEntries(
  url: string,
  entries: ZipEntry[],
  visit: (entry: ZipEntry, bytes: Uint8Array) => Promise<void>,
  options: {
    concurrency: number
    signal?: AbortSignal
    onEntryError?: (entry: ZipEntry, error: unknown) => void
  }
): Promise<void> {
  const groups = planReadGroups(entries)
  let next = 0
  let failure: unknown = null

  const worker = async () => {
    while (failure === null) {
      const index = next++
      if (index >= groups.length) return
      const group = groups[index]!
      try {
        const bytes = await fetchSpan(
          url,
          group.start,
          group.end - group.start,
          options.signal
        )
        const window = { start: group.start, bytes }
        for (const entry of group.entries) {
          if (failure !== null) return
          try {
            const compressed = await entryBytes(url, entry, window, options.signal)
            await visit(entry, expandEntry(entry, compressed))
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
