// Random access into a zip without downloading it.
//
// The published library archive holds every thumbnail, and a mosaic only ever
// paints a fraction of them, so the server reads single entries out of the zip
// with HTTP range requests instead of pulling the whole file. That needs the
// central directory, which lives at the end: read the tail, find the directory,
// then map each name to the byte span of its data.
//
// Zip64 is not optional here. The classic end-of-central-directory record
// stores the entry count in 16 bits, and a large dataset has far more than
// 65,535 thumbnails, so the writer emits Zip64 records and this must read them.
//
// Everything is driven through an injected `RangeReader`, so this file stays
// free of both fetch and fs and can be exercised against a local file.

import { inflateSync } from "fflate"

// Reads bytes [start, end] inclusive — the same span an HTTP range request takes.
export type RangeReader = (start: number, end: number) => Promise<Uint8Array>

export type ZipEntry = {
  // Offset of the local file header, which precedes the entry's data.
  localHeaderOffset: number
  // 0 = stored, 8 = deflate. The library writer stores thumbnails uncompressed
  // (they are already JPEG), so the common path needs no inflate at all.
  method: number
  compressedSize: number
  uncompressedSize: number
}

export type ZipIndex = Map<string, ZipEntry>

const EOCD_SIGNATURE = 0x06054b50
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50
const ZIP64_EOCD_SIGNATURE = 0x06064b50
const CENTRAL_HEADER_SIGNATURE = 0x02014b50
const LOCAL_HEADER_SIGNATURE = 0x04034b50

const EOCD_MIN_BYTES = 22
const ZIP64_LOCATOR_BYTES = 20
const CENTRAL_HEADER_BYTES = 46
const LOCAL_HEADER_BYTES = 30

// The zip comment can be up to 64 KB, so the record we are looking for sits
// somewhere in the last 64 KB + the record's own length.
const TAIL_BYTES = 66 * 1024

// A local header repeats the name and may carry a Zip64 extra field the central
// directory does not. Rather than a second request to measure it, entry reads
// fetch this much slack ahead of the data and parse the real length from it.
const LOCAL_HEADER_SLACK = 4 * 1024

const UINT32_MAX = 0xffffffff
const UINT16_MAX = 0xffff

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

// Zip64 stores 64-bit sizes. Node and the browser both handle these as BigInt;
// every value we read is a byte offset well inside Number's safe range.
function readU64(data: DataView, offset: number): number {
  const value = data.getBigUint64(offset, true)
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("The dataset archive is larger than this reader supports.")
  }
  return Number(value)
}

function findEocd(tail: Uint8Array): number {
  const data = view(tail)
  // Scan backwards: the signature may also appear inside the comment, and the
  // last match is the real record.
  for (let offset = tail.length - EOCD_MIN_BYTES; offset >= 0; offset--) {
    if (data.getUint32(offset, true) === EOCD_SIGNATURE) return offset
  }
  return -1
}

type CentralDirectoryLocation = { offset: number; size: number }

// Where the central directory lives, preferring the Zip64 records when present.
function locateCentralDirectory(
  tail: Uint8Array,
  tailStart: number
): CentralDirectoryLocation {
  const eocdOffset = findEocd(tail)
  if (eocdOffset < 0) {
    throw new Error("The dataset archive is not a readable zip.")
  }
  const data = view(tail)
  let size = data.getUint32(eocdOffset + 12, true)
  let offset = data.getUint32(eocdOffset + 16, true)

  // Either sentinel means the true values are in the Zip64 record.
  const needsZip64 =
    size === UINT32_MAX ||
    offset === UINT32_MAX ||
    data.getUint16(eocdOffset + 10, true) === UINT16_MAX

  if (!needsZip64) return { offset, size }

  const locatorOffset = eocdOffset - ZIP64_LOCATOR_BYTES
  if (
    locatorOffset < 0 ||
    data.getUint32(locatorOffset, true) !== ZIP64_LOCATOR_SIGNATURE
  ) {
    throw new Error("The dataset archive is missing its Zip64 locator.")
  }
  const zip64Offset = readU64(data, locatorOffset + 8)

  // The Zip64 record is normally inside the tail we already read.
  const relative = zip64Offset - tailStart
  if (
    relative < 0 ||
    relative + 56 > tail.length ||
    data.getUint32(relative, true) !== ZIP64_EOCD_SIGNATURE
  ) {
    throw new Error("The dataset archive has an unreadable Zip64 record.")
  }
  size = readU64(data, relative + 40)
  offset = readU64(data, relative + 48)
  return { offset, size }
}

// Pull the 64-bit values out of a central header's Zip64 extra field. Only the
// fields whose 32-bit slots held the sentinel are present, in a fixed order.
function applyZip64Extra(
  entry: ZipEntry,
  extra: Uint8Array,
  sentinels: { size: boolean; compressed: boolean; offset: boolean }
): void {
  const data = view(extra)
  let cursor = 0
  while (cursor + 4 <= extra.length) {
    const id = data.getUint16(cursor, true)
    const length = data.getUint16(cursor + 2, true)
    const body = cursor + 4
    if (id !== 0x0001) {
      cursor = body + length
      continue
    }
    let field = body
    if (sentinels.size && field + 8 <= body + length) {
      entry.uncompressedSize = readU64(data, field)
      field += 8
    }
    if (sentinels.compressed && field + 8 <= body + length) {
      entry.compressedSize = readU64(data, field)
      field += 8
    }
    if (sentinels.offset && field + 8 <= body + length) {
      entry.localHeaderOffset = readU64(data, field)
    }
    return
  }
}

function parseCentralDirectory(directory: Uint8Array): ZipIndex {
  const data = view(directory)
  const index: ZipIndex = new Map()
  const decoder = new TextDecoder()
  let cursor = 0

  while (cursor + CENTRAL_HEADER_BYTES <= directory.length) {
    if (data.getUint32(cursor, true) !== CENTRAL_HEADER_SIGNATURE) break

    const method = data.getUint16(cursor + 10, true)
    const compressedSize = data.getUint32(cursor + 20, true)
    const uncompressedSize = data.getUint32(cursor + 24, true)
    const nameLength = data.getUint16(cursor + 28, true)
    const extraLength = data.getUint16(cursor + 30, true)
    const commentLength = data.getUint16(cursor + 32, true)
    const localHeaderOffset = data.getUint32(cursor + 42, true)

    const nameStart = cursor + CENTRAL_HEADER_BYTES
    const extraStart = nameStart + nameLength
    const name = decoder.decode(directory.subarray(nameStart, extraStart))

    const entry: ZipEntry = {
      localHeaderOffset,
      method,
      compressedSize,
      uncompressedSize,
    }
    const sentinels = {
      size: uncompressedSize === UINT32_MAX,
      compressed: compressedSize === UINT32_MAX,
      offset: localHeaderOffset === UINT32_MAX,
    }
    if (sentinels.size || sentinels.compressed || sentinels.offset) {
      applyZip64Extra(
        entry,
        directory.subarray(extraStart, extraStart + extraLength),
        sentinels
      )
    }

    index.set(name, entry)
    cursor = extraStart + extraLength + commentLength
  }

  return index
}

// Map every entry in the archive to the span its data occupies. One tail read
// plus one central-directory read, after which single entries cost one request.
//
// `totalSize` is required because Zip64 offsets are absolute: without it the
// tail's own position in the file is unknown and they cannot be resolved.
export async function readZipIndex(
  read: RangeReader,
  totalSize: number
): Promise<ZipIndex> {
  const tailStart = Math.max(0, totalSize - TAIL_BYTES)
  const tail = await read(tailStart, totalSize - 1)
  const location = locateCentralDirectory(tail, tailStart)

  // When the tail already contains the whole directory, skip the second read.
  if (location.offset >= tailStart) {
    const from = location.offset - tailStart
    return parseCentralDirectory(tail.subarray(from, from + location.size))
  }
  const directory = await read(
    location.offset,
    location.offset + location.size - 1
  )
  return parseCentralDirectory(directory)
}

// Read one entry's bytes. Stored entries — what the library writer produces —
// come back as the raw file, so a thumbnail needs no decompression at all.
export async function readZipEntry(
  read: RangeReader,
  entry: ZipEntry
): Promise<Uint8Array> {
  const window = await read(
    entry.localHeaderOffset,
    entry.localHeaderOffset +
      LOCAL_HEADER_BYTES +
      LOCAL_HEADER_SLACK +
      entry.compressedSize -
      1
  )
  if (window.length < LOCAL_HEADER_BYTES) {
    throw new Error("The dataset archive entry is truncated.")
  }
  const data = view(window)
  if (data.getUint32(0, true) !== LOCAL_HEADER_SIGNATURE) {
    throw new Error("The dataset archive entry has no local header.")
  }
  const nameLength = data.getUint16(26, true)
  const extraLength = data.getUint16(28, true)
  const dataStart = LOCAL_HEADER_BYTES + nameLength + extraLength

  let body = window.subarray(dataStart, dataStart + entry.compressedSize)
  // The slack normally covers the header, but a large extra field would push
  // the data past the window; re-read exactly where it turned out to be.
  if (body.length < entry.compressedSize) {
    const absolute = entry.localHeaderOffset + dataStart
    body = await read(absolute, absolute + entry.compressedSize - 1)
  }

  if (entry.method === 0) return body
  if (entry.method === 8) return inflateSync(body)
  throw new Error(`Unsupported zip compression method: ${entry.method}.`)
}
