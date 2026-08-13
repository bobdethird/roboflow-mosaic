// Random access into a zip by entry name.
//
// The published library archive holds every thumbnail, and a mosaic only ever
// paints a fraction of them, so the server reads single entries out of the zip
// instead of pulling the whole file. Read the central directory once, map each
// name to its entry, and every later file costs one range request.
//
// This is the small half of the pair of readers over lib/zip-format.ts: the
// other (lib/roboflow-zip.ts) sweeps a stride of images out of a remote export
// and cares about windows and concurrency, while this one looks up a handful of
// files by name and does not.
//
// Everything is driven through an injected `RangeReader`, so this file stays
// free of both fetch and fs and can be exercised against a local file.

import {
  EOCD_SEARCH_BYTES,
  LOCAL_HEADER_FIXED,
  expandEntry,
  localDataOffset,
  locateCentralDirectory,
  parseDirectoryWindow,
  type RangeReader,
  type ZipEntry,
} from "./zip-format"

export type { RangeReader, ZipEntry } from "./zip-format"

export type ZipIndex = Map<string, ZipEntry>

// A local header repeats the name and may carry a Zip64 extra field the central
// directory does not. Rather than a second request to measure it, entry reads
// fetch this much slack ahead of the data and parse the real length from it.
const LOCAL_HEADER_SLACK = 4 * 1024

// A library entry is one thumbnail, a manifest or a signature blob. None comes
// close to this, so it is only here to stop a hostile archive from inflating
// into the function's memory.
const MAX_ENTRY_BYTES = 64 * 1024 * 1024

// Map every entry in the archive to where its data lives. One tail read plus
// one central-directory read, after which single entries cost one request.
//
// `totalSize` is required because Zip64 offsets are absolute: without it the
// tail's own position in the file is unknown and they cannot be resolved.
export async function readZipIndex(
  read: RangeReader,
  totalSize: number
): Promise<ZipIndex> {
  const tailStart = Math.max(0, totalSize - EOCD_SEARCH_BYTES)
  const tail = await read(tailStart, totalSize - 1)
  const { offset, size } = await locateCentralDirectory(tail, tailStart, read)

  // A small archive's directory is already inside the tail that was read.
  const directory =
    offset >= tailStart
      ? tail.subarray(offset - tailStart, offset - tailStart + size)
      : await read(offset, offset + size - 1)

  const index: ZipIndex = new Map()
  parseDirectoryWindow(directory, (entry) => index.set(entry.name, entry))
  return index
}

// One entry's bytes. Stored entries — what the library writer produces for
// thumbnails, which are already JPEG — come back as the raw file.
export async function readZipEntry(
  read: RangeReader,
  entry: ZipEntry
): Promise<Buffer> {
  const window = await read(
    entry.offset,
    entry.offset +
      LOCAL_HEADER_FIXED +
      LOCAL_HEADER_SLACK +
      entry.compressedSize -
      1
  )
  const dataStart = localDataOffset(window, 0, entry.name)

  let body = window.subarray(dataStart, dataStart + entry.compressedSize)
  // The slack normally covers the header, but a large extra field would push
  // the data past the window; re-read exactly where it turned out to be.
  if (body.length < entry.compressedSize) {
    const absolute = entry.offset + dataStart
    body = await read(absolute, absolute + entry.compressedSize - 1)
  }
  return expandEntry(entry, body, MAX_ENTRY_BYTES)
}
