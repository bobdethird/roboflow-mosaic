// The library archive is read with range requests rather than downloaded, so
// these exercise the index against archives written by yazl — the same writer
// `publishDataset` uses — including the Zip64 layout a large dataset forces.

import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import { ZipFile, type EndOptions } from "yazl"

import { readZipEntry, readZipIndex, type RangeReader } from "../lib/zip-index"

type Entry = { name: string; body: Uint8Array }

// Build a zip the way the library publisher does: every entry stored, so a byte
// range inside the archive is the file itself.
async function buildArchive(
  entries: Entry[],
  options: { forceZip64?: boolean; compress?: boolean } = {}
): Promise<Uint8Array> {
  const zip = new ZipFile()
  for (const entry of entries) {
    zip.addBuffer(Buffer.from(entry.body), entry.name, {
      compress: options.compress ?? false,
      forceZip64Format: options.forceZip64 ?? false,
    })
  }
  // @types/yazl requires every EndOptions field; only this one matters here.
  zip.end({ forceZip64Format: options.forceZip64 ?? false } as EndOptions)

  const chunks: Buffer[] = []
  for await (const chunk of zip.outputStream) chunks.push(chunk as Buffer)
  return new Uint8Array(Buffer.concat(chunks))
}

// A reader over an in-memory archive that records every span it was asked for,
// so a test can assert the whole file is never pulled.
function readerFor(archive: Uint8Array): {
  read: RangeReader
  bytesRead: () => number
} {
  let total = 0
  return {
    read: async (start, end) => {
      const clampedEnd = Math.min(end, archive.length - 1)
      total += clampedEnd - start + 1
      return archive.subarray(start, clampedEnd + 1)
    },
    bytesRead: () => total,
  }
}

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values)
}

test("reads a single stored entry without downloading the archive", async () => {
  const thumb = bytes(0xff, 0xd8, 0xff, 0xd9)
  const filler = new Uint8Array(512 * 1024).fill(7)
  const archive = await buildArchive([
    { name: "manifest.json", body: new TextEncoder().encode('{"a":1}') },
    { name: "thumbs/0123456789abcdef.jpg", body: thumb },
    { name: "thumbs/filler.jpg", body: filler },
  ])

  const { read, bytesRead } = readerFor(archive)
  const index = await readZipIndex(read, archive.length)

  assert.ok(index.has("manifest.json"))
  const entry = index.get("thumbs/0123456789abcdef.jpg")
  assert.ok(entry)
  assert.equal(entry.method, 0)
  assert.equal(entry.uncompressedSize, thumb.length)

  assert.deepEqual(Array.from(await readZipEntry(read, entry)), Array.from(thumb))

  // The point of the exercise: one small entry costs far less than the archive.
  assert.ok(
    bytesRead() < archive.length / 2,
    `read ${bytesRead()} of ${archive.length} bytes`
  )
})

test("resolves Zip64 offsets, which a large dataset's archive requires", async () => {
  const thumb = bytes(0xff, 0xd8, 0x11, 0x22, 0xff, 0xd9)
  const archive = await buildArchive(
    [
      { name: "signatures-coarse.bin", body: new Uint8Array(384).fill(3) },
      { name: "thumbs/abcdefabcdef0123.jpg", body: thumb },
    ],
    { forceZip64: true }
  )

  const { read } = readerFor(archive)
  const index = await readZipIndex(read, archive.length)

  const entry = index.get("thumbs/abcdefabcdef0123.jpg")
  assert.ok(entry)
  assert.deepEqual(Array.from(await readZipEntry(read, entry)), Array.from(thumb))

  const signatures = index.get("signatures-coarse.bin")
  assert.ok(signatures)
  assert.equal((await readZipEntry(read, signatures)).length, 384)
})

test("inflates a deflated entry rather than returning compressed bytes", async () => {
  const body = new TextEncoder().encode("x".repeat(4096))
  const archive = await buildArchive([{ name: "manifest.json", body }], {
    compress: true,
  })

  const { read } = readerFor(archive)
  const index = await readZipIndex(read, archive.length)
  const entry = index.get("manifest.json")
  assert.ok(entry)
  assert.equal(entry.method, 8)
  assert.deepEqual(Array.from(await readZipEntry(read, entry)), Array.from(body))
})

test("reads entries from an archive on disk through a file-backed reader", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zip-index-test-"))
  try {
    const thumb = bytes(0xff, 0xd8, 0x42, 0xff, 0xd9)
    const archive = await buildArchive([
      { name: "icon.jpg", body: bytes(1, 2, 3) },
      { name: "thumbs/deadbeefdeadbeef.jpg", body: thumb },
    ])
    const file = path.join(root, "library.zip")
    await writeFile(file, archive)

    const contents = new Uint8Array(await readFile(file))
    const read: RangeReader = async (start, end) =>
      contents.subarray(start, Math.min(end, contents.length - 1) + 1)

    const index = await readZipIndex(read, contents.length)
    const entry = index.get("thumbs/deadbeefdeadbeef.jpg")
    assert.ok(entry)
    assert.deepEqual(
      Array.from(await readZipEntry(read, entry)),
      Array.from(thumb)
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
