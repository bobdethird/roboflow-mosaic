// Reading a zip without having the zip: the format parts, and nothing else.
//
// Readers sit on top of this when they need a named entry out of a zip without
// holding the whole archive. What they share is the awkward part of the format:
// the central directory lives at the end, behind a record that can be hidden
// under a 64 KB comment, and every 32-bit field in it saturates on a large
// archive and moves into a Zip64 record somewhere else.
//
// Zip64 is not a corner case here. The classic end-of-central-directory record
// counts entries in 16 bits, and a dataset with more than 65,535 images — which
// is the case this whole design exists for — overflows it.
//
// Nothing in this file performs I/O of its own. Callers pass bytes they have
// already read, plus a `RangeReader` for the rare span that turns out to sit
// outside them, which keeps fetch policy (buffer reuse, retries, caching) with
// the reader that cares about it.

import { promisify } from "node:util"
import { inflateRaw as inflateRawCallback } from "node:zlib"

const inflateRaw = promisify(inflateRawCallback)

// Reads bytes [start, end] inclusive — the same span an HTTP range request takes.
export type RangeReader = (start: number, end: number) => Promise<Buffer>

export type ZipEntry = {
  name: string
  // Offset of the entry's local file header, which precedes its data.
  offset: number
  compressedSize: number
  uncompressedSize: number
  // 0 stored, 8 deflate. Callers skip anything else.
  method: number
}

export class ZipReadError extends Error {}

export const STORED = 0
export const DEFLATED = 8

const EOCD_SIG = 0x06054b50
const EOCD64_SIG = 0x06064b50
const EOCD64_LOCATOR_SIG = 0x07064b50
const CENTRAL_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50

const EOCD_FIXED = 22
const EOCD64_FIXED = 56
const EOCD64_LOCATOR_FIXED = 20
const CENTRAL_HEADER_FIXED = 46
export const LOCAL_HEADER_FIXED = 30

// A zip comment can be 64 KB and the end-of-central-directory record sits before
// it, so this is the largest tail worth scanning for the record.
export const EOCD_SEARCH_BYTES = 64 * 1024 + EOCD_FIXED + EOCD64_LOCATOR_FIXED

const UINT32_MAX = 0xffffffff
const UINT16_MAX = 0xffff

function readU64(bytes: Buffer, at: number): number {
  const value = bytes.readBigUInt64LE(at)
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ZipReadError("The archive declares an implausible size.")
  }
  return Number(value)
}

// The record is the last thing in the file except its own comment, so a match
// is only real if the comment length it declares reaches exactly the end.
function findEocd(tail: Buffer): number {
  for (let at = tail.length - EOCD_FIXED; at >= 0; at--) {
    if (tail.readUInt32LE(at) !== EOCD_SIG) continue
    if (at + EOCD_FIXED + tail.readUInt16LE(at + 20) === tail.length) return at
  }
  throw new ZipReadError("The archive has no end-of-central-directory record.")
}

export type CentralDirectory = { offset: number; size: number }

// The Zip64 record is usually inside the tail already read; a long comment can
// push it out, and then it costs one more range request.
async function zip64Record(
  at: number,
  tail: Buffer,
  tailStart: number,
  read?: RangeReader
): Promise<Buffer> {
  const relative = at - tailStart
  if (relative >= 0 && relative + EOCD64_FIXED <= tail.length) {
    return tail.subarray(relative, relative + EOCD64_FIXED)
  }
  if (!read) {
    throw new ZipReadError("The archive's zip64 record is out of reach.")
  }
  return read(at, at + EOCD64_FIXED - 1)
}

// Where the central directory lives, preferring Zip64 values whenever the
// classic record admits it is out of room.
//
// `tail` must end at the last byte of the archive, and `tailStart` is its offset
// within it — Zip64 offsets are absolute, so a tail that does not know where it
// sits cannot resolve them.
export async function locateCentralDirectory(
  tail: Buffer,
  tailStart: number,
  read?: RangeReader
): Promise<CentralDirectory> {
  const at = findEocd(tail)
  let size = tail.readUInt32LE(at + 12)
  let offset = tail.readUInt32LE(at + 16)
  const saturated =
    size === UINT32_MAX ||
    offset === UINT32_MAX ||
    // More entries than 16 bits can count. The directory's own offset and size
    // may still fit, but the Zip64 record is the authority once this overflows.
    tail.readUInt16LE(at + 10) === UINT16_MAX

  if (saturated) {
    const locator = at - EOCD64_LOCATOR_FIXED
    const located =
      locator >= 0 && tail.readUInt32LE(locator) === EOCD64_LOCATOR_SIG
    if (!located) {
      // Only the entry count overflowed and there is no locator: the classic
      // offset and size are still usable.
      if (size !== UINT32_MAX && offset !== UINT32_MAX) return { offset, size }
      throw new ZipReadError("The archive is missing its zip64 locator.")
    }
    const record = await zip64Record(
      readU64(tail, locator + 8),
      tail,
      tailStart,
      read
    )
    if (record.readUInt32LE(0) !== EOCD64_SIG) {
      throw new ZipReadError("The archive has a malformed zip64 record.")
    }
    size = readU64(record, 40)
    offset = readU64(record, 48)
  }
  return { offset, size }
}

// Zip64 extra field: the 8-byte values that replace whichever 32-bit fields
// saturated, in a fixed order and only for those that did.
function applyZip64Extra(
  extra: Buffer,
  entry: ZipEntry,
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

// Parse as many whole central-directory records as `buffer` holds, reporting
// each one. Returns how many bytes were consumed, so a caller reading the
// directory in windows can carry the remainder into the next one, and whether
// the directory ended (a record that is not a record ends it).
//
// Every entry is reported, directories included. Which ones are interesting is
// the caller's business.
export function parseDirectoryWindow(
  buffer: Buffer,
  onEntry: (entry: ZipEntry) => void
): { consumed: number; done: boolean } {
  let at = 0
  for (;;) {
    if (at + CENTRAL_HEADER_FIXED > buffer.length) {
      return { consumed: at, done: false }
    }
    if (buffer.readUInt32LE(at) !== CENTRAL_SIG)
      return { consumed: at, done: true }

    const nameLength = buffer.readUInt16LE(at + 28)
    const extraLength = buffer.readUInt16LE(at + 30)
    const commentLength = buffer.readUInt16LE(at + 32)
    const total =
      CENTRAL_HEADER_FIXED + nameLength + extraLength + commentLength
    if (at + total > buffer.length) return { consumed: at, done: false }

    const compressedSize = buffer.readUInt32LE(at + 20)
    const uncompressedSize = buffer.readUInt32LE(at + 24)
    const offset = buffer.readUInt32LE(at + 42)
    const nameStart = at + CENTRAL_HEADER_FIXED
    const extraStart = nameStart + nameLength
    const entry: ZipEntry = {
      name: buffer.subarray(nameStart, extraStart).toString("utf8"),
      offset,
      compressedSize,
      uncompressedSize,
      method: buffer.readUInt16LE(at + 10),
    }
    if (
      compressedSize === UINT32_MAX ||
      uncompressedSize === UINT32_MAX ||
      offset === UINT32_MAX
    ) {
      applyZip64Extra(
        buffer.subarray(extraStart, extraStart + extraLength),
        entry,
        {
          compressed: compressedSize === UINT32_MAX,
          uncompressed: uncompressedSize === UINT32_MAX,
          offset: offset === UINT32_MAX,
        }
      )
    }
    at += total
    onEntry(entry)
  }
}

// How far past an entry's local header its data begins. The local header
// repeats the name and may carry a different extra field than the central
// directory did, so this is only knowable from the header itself.
export function localDataOffset(
  header: Buffer,
  at: number,
  name: string
): number {
  if (at + LOCAL_HEADER_FIXED > header.length) {
    throw new ZipReadError(`Short read for ${name}.`)
  }
  if (header.readUInt32LE(at) !== LOCAL_SIG) {
    throw new ZipReadError(`${name} is not where the archive said it was.`)
  }
  return (
    LOCAL_HEADER_FIXED +
    header.readUInt16LE(at + 26) +
    header.readUInt16LE(at + 28)
  )
}

// Expand an entry's data. Stored entries — what the library writer produces for
// thumbnails, which are already JPEG — come back untouched.
//
// `limit` bounds the output so a hostile archive cannot inflate into the
// function's memory.
export async function expandEntry(
  entry: ZipEntry,
  compressed: Buffer,
  limit: number
): Promise<Buffer> {
  if (entry.method === STORED) return compressed
  if (entry.method !== DEFLATED) {
    throw new ZipReadError(
      `Unsupported zip compression method: ${entry.method}.`
    )
  }
  const bound = Math.min(
    limit,
    Math.max(entry.uncompressedSize + 64 * 1024, 1024 * 1024)
  )
  return Buffer.from(await inflateRaw(compressed, { maxOutputLength: bound }))
}
