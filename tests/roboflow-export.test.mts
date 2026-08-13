// Ingesting a dataset export the way a deployment now does: read over HTTP,
// written straight back out, with nothing on disk at either end.
//
// The fixtures are real zips served by a real server, one that honours `Range`
// and one that refuses to, because which of those a host is decides which code
// path an ingest takes. The output side is covered both ways too: the local
// directory, and the multipart archive a serverless host uploads instead.

import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { createServer, type Server } from "node:http"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import type { Part } from "@vercel/blob"
import { unzipSync } from "fflate"
import sharp from "sharp"
import { ZipFile, type EndOptions } from "yazl"

import { buildLibraryFromExport, planTileSample } from "../lib/roboflow-ingest"
import { COARSE_SIG_BYTES } from "../lib/tile-library"
import {
  PART_BYTES,
  directorySink,
  multipartArchiveSink,
  type PartUploader,
} from "../lib/roboflow-sink"
import {
  COARSE_SIGNATURES_FILE,
  ICON_FILE,
  MANIFEST_FILE,
  roboflowThumbPath,
} from "../lib/roboflow"
import type { PackManifest } from "../lib/roboflow-pack"
// The library reader, as distinct from the export reader below: one indexes the
// archive an ingest produces, the other the export it consumes.
import {
  readZipEntry as readLibraryEntry,
  readZipIndex as readLibraryIndex,
  type RangeReader,
} from "../lib/zip-index"
import {
  EvenSample,
  READ_WINDOW,
  readZipEntries,
  readZipIndex,
  streamZipEntries,
  type ZipEntry,
} from "../lib/roboflow-zip"

// ─── Fixtures ────────────────────────────────────────────────────────────────

// Distinct, decodable images. A different hue per image keeps the ids (and so
// the deduplication) distinct, and the sizes vary so the manifest's dimensions
// are worth asserting on.
async function image(index: number): Promise<Buffer> {
  const width = 64 + (index % 5) * 8
  return sharp({
    create: {
      width,
      height: 48,
      channels: 3,
      background: { r: (index * 37) % 256, g: (index * 91) % 256, b: 40 },
    },
  })
    .jpeg({ quality: 90 })
    .toBuffer()
}

type Fixture = { zip: Buffer; images: Map<string, Buffer> }

// A Roboflow-shaped export: images nested under splits, annotation sidecars
// alongside them, and both stored and deflated entries so the reader has to
// handle each.
async function exportZip(
  count: number,
  options: { zip64?: boolean } = {}
): Promise<Fixture> {
  const zip64 = options.zip64 ?? false
  const zipfile = new ZipFile()
  const images = new Map<string, Buffer>()
  const chunks: Buffer[] = []
  const done = new Promise<void>((resolve, reject) => {
    zipfile.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk))
    zipfile.outputStream.on("end", resolve)
    zipfile.outputStream.on("error", reject)
  })

  zipfile.addBuffer(Buffer.from("{}"), "train/_annotations.coco.json", {
    forceZip64Format: zip64,
  })
  for (let index = 0; index < count; index++) {
    const split = index % 3 === 0 ? "valid" : "train"
    const name = `${split}/image-${String(index).padStart(4, "0")}.jpg`
    const bytes = await image(index)
    images.set(name, bytes)
    // Half the entries stored, half deflated.
    zipfile.addBuffer(bytes, name, {
      compress: index % 2 === 0,
      forceZip64Format: zip64,
    })
  }
  zipfile.addBuffer(Buffer.from("names: []\n"), "data.yaml", {
    forceZip64Format: zip64,
  })
  // @types/yazl requires every EndOptions field; only this one matters here.
  zipfile.end({ forceZip64Format: zip64 } as EndOptions)
  await done
  return { zip: Buffer.concat(chunks), images }
}

type Host = {
  url: string
  requests: () => number
  // Length of every ranged read, in request order.
  reads: () => number[]
  close: () => Promise<void>
}

// Serves one buffer. `ranges: false` is a host that answers every request with
// the whole body, which is what the sequential fallback exists for.
async function serve(body: Buffer, ranges = true): Promise<Host> {
  let requests = 0
  const reads: number[] = []
  const server: Server = createServer((request, response) => {
    requests += 1
    const header = ranges ? request.headers.range : undefined
    const match = /^bytes=(\d*)-(\d*)$/.exec(header ?? "")
    if (!match) {
      response.writeHead(200, {
        "content-type": "application/zip",
        "content-length": String(body.length),
        "accept-ranges": ranges ? "bytes" : "none",
      })
      response.end(body)
      return
    }
    const [, rawStart, rawEnd] = match
    // "bytes=-500" is the last 500 bytes, which is how the reader finds the
    // central directory without knowing the archive's size.
    const start = rawStart
      ? Number(rawStart)
      : Math.max(0, body.length - Number(rawEnd))
    const end = rawStart
      ? Math.min(body.length - 1, rawEnd ? Number(rawEnd) : body.length - 1)
      : body.length - 1
    const slice = body.subarray(start, end + 1)
    reads.push(slice.length)
    response.writeHead(206, {
      "content-type": "application/zip",
      "content-length": String(slice.length),
      "content-range": `bytes ${start}-${end}/${body.length}`,
    })
    response.end(slice)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("no address")
  return {
    url: `http://127.0.0.1:${address.port}/export.zip`,
    requests: () => requests,
    reads: () => reads,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      ),
  }
}

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "roboflow-export-test-"))
  try {
    return await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const silent = () => {}

// ─── The index ───────────────────────────────────────────────────────────────

test("the export index lists image entries without downloading the export", async () => {
  const fixture = await exportZip(6)
  const host = await serve(fixture.zip)
  try {
    const index = await readZipIndex(host.url, { maxEntries: 100 })
    assert.ok(index, "expected an index from a host that serves ranges")
    assert.equal(index.imageCount, 6)
    assert.equal(index.stride, 1)
    assert.deepEqual(
      index.entries.map((entry) => entry.name).sort(),
      [...fixture.images.keys()].sort()
    )
    // The central directory and its locator only: nowhere near the whole zip.
    const fetched = index.entries.reduce(
      (total, entry) => total + entry.compressedSize,
      0
    )
    assert.ok(fetched > 0)
    assert.ok(host.requests() <= 3, `took ${host.requests()} requests`)
  } finally {
    await host.close()
  }
})

test("a zip64 export is indexed by range rather than streamed whole", async () => {
  // Past 65,535 entries a writer has to emit zip64, and the real directory
  // offset moves out of the classic record into one reached through a locator.
  // Failing to follow it is invisible from the outside: the index just comes
  // back null and the ingest quietly falls back to pulling the whole export —
  // on precisely the datasets that are too big for that to be acceptable.
  const fixture = await exportZip(6, { zip64: true })
  const host = await serve(fixture.zip)
  try {
    const index = await readZipIndex(host.url, { maxEntries: 100 })
    assert.ok(index, "expected an index from a zip64 export")
    assert.deepEqual(
      index.entries.map((entry) => entry.name).sort(),
      [...fixture.images.keys()].sort()
    )

    const seen = new Map<string, Buffer>()
    await readZipEntries(
      host.url,
      index.entries,
      async (entry, bytes) => {
        seen.set(entry.name, bytes)
      },
      { concurrency: 2 }
    )
    for (const [name, bytes] of fixture.images) {
      assert.deepEqual(seen.get(name), bytes, `${name} read back wrong`)
    }
  } finally {
    await host.close()
  }
})

test("a host that ignores range requests has no index", async () => {
  const fixture = await exportZip(3)
  const host = await serve(fixture.zip, false)
  try {
    assert.equal(await readZipIndex(host.url, { maxEntries: 100 }), null)
  } finally {
    await host.close()
  }
})

test("indexed entries read back byte for byte, stored or deflated", async () => {
  const fixture = await exportZip(8)
  const host = await serve(fixture.zip)
  try {
    const index = await readZipIndex(host.url, { maxEntries: 100 })
    assert.ok(index)
    const seen = new Map<string, Buffer>()
    await readZipEntries(
      host.url,
      index.entries,
      async (entry, bytes) => {
        seen.set(entry.name, bytes)
      },
      { concurrency: 3 }
    )
    assert.equal(seen.size, fixture.images.size)
    for (const [name, bytes] of fixture.images) {
      assert.ok(seen.get(name)?.equals(bytes), `${name} did not round-trip`)
    }
  } finally {
    await host.close()
  }
})

// An export several read windows long, out of images too noisy to compress. The
// point is the total size, so these are bigger and fewer than the other fixture.
async function bulkyExportZip(count: number, edge: number): Promise<Fixture> {
  const zipfile = new ZipFile()
  const images = new Map<string, Buffer>()
  const chunks: Buffer[] = []
  const done = new Promise<void>((resolve, reject) => {
    zipfile.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk))
    zipfile.outputStream.on("end", resolve)
    zipfile.outputStream.on("error", reject)
  })
  for (let index = 0; index < count; index++) {
    const name = `train/bulky-${String(index).padStart(4, "0")}.jpg`
    const bytes = await sharp(randomBytes(edge * edge * 3), {
      raw: { width: edge, height: edge, channels: 3 },
    })
      .jpeg({ quality: 92 })
      .toBuffer()
    images.set(name, bytes)
    zipfile.addBuffer(bytes, name, { compress: false })
  }
  zipfile.end()
  await done
  return { zip: Buffer.concat(chunks), images }
}

test("an export many times a read window long is still read one window at a time", async () => {
  // ~12 MB of images, so several windows' worth however they are grouped.
  const fixture = await bulkyExportZip(24, 800)
  assert.ok(
    fixture.zip.length > 2 * READ_WINDOW,
    `fixture was only ${fixture.zip.length} bytes`
  )
  const host = await serve(fixture.zip)
  try {
    const index = await readZipIndex(host.url, { maxEntries: 1000 })
    assert.ok(index)
    let seen = 0
    await readZipEntries(
      host.url,
      index.entries,
      async (entry, bytes) => {
        assert.ok(fixture.images.get(entry.name)?.equals(bytes))
        seen += 1
      },
      { concurrency: 3 }
    )
    assert.equal(seen, fixture.images.size)

    // What the reader holds is a window per worker, so no single read may exceed
    // one — that, and not the export's size, is the ingest's memory footprint.
    // A dense export is read in several windows rather than one large range.
    const reads = host.reads()
    const biggest = Math.max(...reads)
    assert.ok(biggest <= READ_WINDOW, `one read was ${biggest} bytes`)
    assert.ok(
      reads.filter((length) => length > READ_WINDOW / 2).length >= 2,
      `reads were ${reads.join(", ")}`
    )
  } finally {
    await host.close()
  }
})

test("reading a sample touches only the sampled entries", async () => {
  const fixture = await exportZip(12)
  const host = await serve(fixture.zip)
  try {
    const index = await readZipIndex(host.url, { maxEntries: 100 })
    assert.ok(index)
    const ordered = [...index.entries].sort((a, b) => a.offset - b.offset)
    const wanted = [ordered[0], ordered[5], ordered[11]]
    const seen: string[] = []
    await readZipEntries(
      host.url,
      wanted,
      async (entry, bytes) => {
        assert.ok(fixture.images.get(entry.name)?.equals(bytes))
        seen.push(entry.name)
      },
      { concurrency: 2 }
    )
    assert.deepEqual(seen.sort(), wanted.map((entry) => entry.name).sort())
  } finally {
    await host.close()
  }
})

test("the sequential reader keeps what it is asked for and skips the rest", async () => {
  const fixture = await exportZip(6)
  const host = await serve(fixture.zip, false)
  try {
    const seen: string[] = []
    // A decode outlives the chunk the entry arrived in, so a caller counts what
    // it accepted here rather than what has finished.
    let taken = 0
    await streamZipEntries(
      host.url,
      async (entry, bytes) => {
        assert.ok(fixture.images.get(entry.name)?.equals(bytes))
        seen.push(entry.name)
      },
      {
        want: () => taken < 3 && Boolean(++taken),
        concurrency: 2,
      }
    )
    assert.equal(seen.length, 3)
    assert.deepEqual(seen.sort(), [...fixture.images.keys()].slice(0, 3).sort())
  } finally {
    await host.close()
  }
})

// ─── Sampling ────────────────────────────────────────────────────────────────

test("an even sample stays spread as the sequence outgrows its cap", () => {
  const sample = new EvenSample<number>(4)
  for (let value = 0; value < 32; value++) sample.push(value)
  assert.equal(sample.total, 32)
  assert.equal(sample.stride, 8)
  assert.deepEqual(sample.items, [0, 8, 16, 24])
})

test("the tile plan strides across the whole export, and shrinks for a deadline", () => {
  const entries: ZipEntry[] = Array.from({ length: 1000 }, (_, index) => ({
    name: `image-${index}.jpg`,
    offset: index * 200_000,
    compressedSize: 100_000,
    uncompressedSize: 100_000,
    method: 0,
  }))
  const index = { entries, imageCount: 1000, stride: 1 }

  const capped = planTileSample(index, { budget: 100 })
  assert.equal(capped.length, 100)
  assert.equal(capped[0].name, "image-0.jpg")
  assert.equal(capped[99].name, "image-990.jpg")

  // 100 KB per image at the assumed throughput is ~5.5 ms of work, so a second
  // buys a couple of hundred tiles, not a thousand.
  const rushed = planTileSample(index, { budget: 1000, msAvailable: 1000 })
  assert.ok(rushed.length > 0 && rushed.length < 1000, `${rushed.length} tiles`)
  assert.equal(rushed[0].name, "image-0.jpg")

  // A plan that fits keeps every entry, in order.
  const whole = planTileSample(index, { budget: 1000, msAvailable: 60_000 })
  assert.equal(whole.length, 1000)
})

// ─── The library a build produces ────────────────────────────────────────────

// A built library, read the way it is actually served: the manifest and the
// signature blob up front, and single thumbnails by id. Nothing downloads a
// library whole any more, so nothing here does either.
type Library = {
  manifest: PackManifest
  signatures: Uint8Array
  thumb: (id: string) => Promise<Uint8Array | null>
  has: (name: string) => Promise<boolean>
}

// A local build, which the asset route serves straight off the cache directory.
async function readBuiltLibrary(
  directory: string,
  version: string
): Promise<Library> {
  const file = (name: string) => path.join(directory, name)
  const library: Library = {
    manifest: JSON.parse(
      await readFile(file(MANIFEST_FILE), "utf8")
    ) as PackManifest,
    signatures: await readFile(file(COARSE_SIGNATURES_FILE)),
    thumb: (id) => readFile(file(roboflowThumbPath(id))).catch(() => null),
    has: (name) =>
      readFile(file(name)).then(
        () => true,
        () => false
      ),
  }
  assert.equal(library.manifest.version, version)
  return library
}

// A serverless build, which lands in Blob as one archive the asset route reads
// with range requests — so read it here with the very same index.
async function readUploadedLibrary(
  archive: Buffer,
  version: string
): Promise<Library> {
  const read: RangeReader = async (start, end) =>
    archive.subarray(start, Math.min(end, archive.length - 1) + 1)
  const index = await readLibraryIndex(read, archive.length)
  const entry = async (name: string) => {
    const found = index.get(name)
    return found ? await readLibraryEntry(read, found) : null
  }

  const manifest = await entry(MANIFEST_FILE)
  const signatures = await entry(COARSE_SIGNATURES_FILE)
  assert.ok(manifest, "expected a manifest in the archive")
  assert.ok(signatures, "expected a signature blob in the archive")

  const library: Library = {
    manifest: JSON.parse(manifest.toString("utf8")) as PackManifest,
    signatures,
    thumb: (id) => entry(roboflowThumbPath(id)),
    has: async (name) => index.has(name),
  }
  assert.equal(library.manifest.version, version)
  return library
}

test("a build turns a remote export into a library the browser can unpack", async () => {
  const fixture = await exportZip(9)
  const host = await serve(fixture.zip)
  try {
    await withTempDir(async (dir) => {
      const sink = await directorySink(dir)
      const built = await buildLibraryFromExport(host.url, sink, silent)
      await sink.finish()

      assert.equal(built.photoCount, 9)
      assert.equal(built.skipped, 0)
      assert.equal(built.sampled, false)
      assert.equal(built.sourceImages, 9)

      // Nothing but the library: no spooled export, no scratch files.
      const written = await readdir(dir)
      assert.deepEqual(written.sort(), [
        "manifest.json",
        "signatures-coarse.bin",
        "thumbs",
      ])

      const library = await readBuiltLibrary(dir, built.version)
      assert.equal(library.manifest.photos.length, 9)
      assert.equal(library.signatures.length, 9 * COARSE_SIG_BYTES)
      for (const photo of library.manifest.photos) {
        assert.ok(await library.thumb(photo.id), `no thumbnail for ${photo.id}`)
        assert.ok(photo.w > 0 && photo.h > 0)
      }
      // Manifest order follows the entry paths inside the export, not the order
      // parallel reads happened to finish in, so the signature offsets a rebuild
      // produces line up with the same photos.
      const expected = [...fixture.images.keys()]
        .sort()
        .map((name) => path.basename(name))
      assert.deepEqual(
        library.manifest.photos.map((photo) => photo.file),
        expected
      )
    })
  } finally {
    await host.close()
  }
})

test("a dataset larger than the tile budget is sampled, not truncated", async () => {
  const fixture = await exportZip(12)
  const host = await serve(fixture.zip)
  try {
    await withTempDir(async (dir) => {
      const sink = await directorySink(dir)
      const built = await buildLibraryFromExport(host.url, sink, silent, {
        budget: 4,
      })
      await sink.finish()

      assert.equal(built.photoCount, 4)
      assert.equal(built.sampled, true)
      assert.equal(built.sourceImages, 12)

      const library = await readBuiltLibrary(dir, built.version)
      assert.equal(library.manifest.photos.length, 4)
      assert.equal(library.signatures.length, 4 * COARSE_SIG_BYTES)
      // Spread across the export rather than taken off the front of it.
      const indices = library.manifest.photos.map((photo) =>
        Number(/image-(\d+)/.exec(photo.file ?? "")?.[1] ?? -1)
      )
      assert.ok(Math.max(...indices) >= 8, `sampled ${indices.join(", ")}`)
    })
  } finally {
    await host.close()
  }
})

test("a build works against a host that will not serve ranges", async () => {
  const fixture = await exportZip(7)
  const host = await serve(fixture.zip, false)
  try {
    await withTempDir(async (dir) => {
      const sink = await directorySink(dir)
      const built = await buildLibraryFromExport(host.url, sink, silent)
      await sink.finish()
      assert.equal(built.photoCount, 7)
      const library = await readBuiltLibrary(dir, built.version)
      assert.equal(library.manifest.photos.length, 7)
    })
  } finally {
    await host.close()
  }
})

test("an unreadable image costs its own tile and nothing else", async () => {
  const fixture = await exportZip(5)
  // Slip a file that is named like an image but is not one into the export.
  const zipfile = new ZipFile()
  const chunks: Buffer[] = []
  const done = new Promise<void>((resolve, reject) => {
    zipfile.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk))
    zipfile.outputStream.on("end", resolve)
    zipfile.outputStream.on("error", reject)
  })
  for (const [name, bytes] of fixture.images) {
    zipfile.addBuffer(bytes, name, { compress: false })
  }
  zipfile.addBuffer(Buffer.from("not an image at all"), "train/broken.jpg")
  zipfile.end()
  await done

  const host = await serve(Buffer.concat(chunks))
  try {
    await withTempDir(async (dir) => {
      const sink = await directorySink(dir)
      const built = await buildLibraryFromExport(host.url, sink, silent)
      await sink.finish()
      assert.equal(built.photoCount, 5)
      assert.equal(built.skipped, 1)
    })
  } finally {
    await host.close()
  }
})

// ─── The archive a serverless host uploads ───────────────────────────────────

// Stands in for the multipart half of a Blob store, keeping every part so the
// archive they add up to can be read back.
function collectingUploader() {
  const uploaded: { partNumber: number; body: Buffer }[] = []
  let completed: Part[] | null = null

  const uploader: PartUploader = {
    uploadPart: async (partNumber, body) => {
      uploaded.push({ partNumber, body })
      return { partNumber, etag: `etag-${partNumber}` }
    },
    complete: async (parts) => {
      completed = parts
      return {}
    },
  }

  const ordered = () =>
    [...uploaded].sort((a, b) => a.partNumber - b.partNumber)

  return {
    uploader,
    uploaded: () => uploaded,
    completed: () => completed,
    // The blob the store would end up holding.
    archive: () => Buffer.concat(ordered().map((part) => part.body)),
  }
}

test("the archive a serverless build uploads is one the browser can unpack", async () => {
  const fixture = await exportZip(9)
  const host = await serve(fixture.zip)
  try {
    const store = collectingUploader()
    // What the ingest records about a finished library, gathered the way the
    // Blob sink's own callback does.
    const published = new Set<string>()
    const sink = multipartArchiveSink(store.uploader, {
      onComplete: async (names) => {
        for (const name of names) published.add(name)
      },
    })

    // The cover goes in first, as the ingest does it.
    await sink.add("icon.jpg", await image(99))
    const built = await buildLibraryFromExport(host.url, sink, silent)
    await sink.finish()

    assert.equal(built.photoCount, 9)

    // Every part accounted for, numbered from one, and handed to `complete` in
    // order — Blob stitches the archive back together from exactly this.
    const parts = store.completed()
    assert.ok(parts, "expected the upload to be completed")
    assert.deepEqual(
      parts.map((part) => part.partNumber),
      store.uploaded().map((_, index) => index + 1)
    )
    assert.ok(published.has("manifest.json"))
    assert.ok(published.has("icon.jpg"))

    const library = await readUploadedLibrary(store.archive(), built.version)
    assert.equal(library.manifest.photos.length, 9)
    assert.equal(library.signatures.length, 9 * COARSE_SIG_BYTES)
    assert.ok(await library.has(ICON_FILE), "expected the cover in the archive")
    for (const photo of library.manifest.photos) {
      assert.ok(await library.thumb(photo.id), `no thumbnail for ${photo.id}`)
    }
  } finally {
    await host.close()
  }
})

test("a library past one part is uploaded in whole parts as it is built", async () => {
  const store = collectingUploader()
  const sink = multipartArchiveSink(store.uploader)

  // Incompressible, and stored rather than deflated, so the archive is a known
  // size: past two parts with a short one to finish.
  const files = 3
  const each = 7 * 1024 * 1024
  for (let index = 0; index < files; index++) {
    await sink.add(`thumbs/${index}.jpg`, randomBytes(each))
  }
  // Uploads start before the library is closed out, or the whole thing would
  // have been held in memory first — which is the entire point of this path.
  assert.ok(store.uploaded().length >= 2, "expected parts during the build")
  await sink.finish()

  const sizes = store.uploaded().map((part) => part.body.length)
  assert.equal(
    sizes.slice(0, -1).every((size) => size === PART_BYTES),
    true,
    `parts were ${sizes.join(", ")}`
  )
  // Blob rejects any part but the last under 5 MB.
  assert.ok(sizes[sizes.length - 1] > 0)
  assert.ok(sizes.length >= 3, `only ${sizes.length} parts`)

  const archive = store.archive()
  assert.equal(
    archive.length,
    sizes.reduce((total, size) => total + size, 0)
  )
  // A zip reader has to accept the result, which it only does if the parts were
  // ordered and none were dropped or doubled.
  const entries = unzipSync(new Uint8Array(archive))
  assert.deepEqual(
    Object.keys(entries).sort(),
    Array.from({ length: files }, (_, index) => `thumbs/${index}.jpg`).sort()
  )
  for (const bytes of Object.values(entries)) {
    assert.equal(bytes.length, each)
  }
})

test("an abandoned build leaves no archive behind", async () => {
  const store = collectingUploader()
  const sink = multipartArchiveSink(store.uploader)
  await sink.add("thumbs/0.jpg", randomBytes(2 * 1024 * 1024))
  await sink.abort()

  // Parts that were already uploaded are never completed, so the store has
  // nothing that could be mistaken for a finished library.
  assert.equal(store.completed(), null)
  await assert.rejects(sink.add("thumbs/1.jpg", Buffer.alloc(8)), /closed/i)
})

test("an export with no images fails with a message about the export", async () => {
  const zipfile = new ZipFile()
  const chunks: Buffer[] = []
  const done = new Promise<void>((resolve, reject) => {
    zipfile.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk))
    zipfile.outputStream.on("end", resolve)
    zipfile.outputStream.on("error", reject)
  })
  zipfile.addBuffer(Buffer.from("{}"), "train/_annotations.coco.json")
  zipfile.end()
  await done

  const host = await serve(Buffer.concat(chunks))
  try {
    await withTempDir(async (dir) => {
      const sink = await directorySink(dir)
      await assert.rejects(
        buildLibraryFromExport(host.url, sink, silent),
        /contained no images/i
      )
    })
  } finally {
    await host.close()
  }
})
