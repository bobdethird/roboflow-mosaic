// Ingesting a Roboflow project through the per-image API: paginated search,
// thumbnail fetch, signature/thumb seeding, and versioned partial snapshots.

import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import sharp from "sharp"

import {
  buildLibraryFromImages,
  buildLibraryFromSearch,
  resolveDataset,
} from "../lib/roboflow-ingest"
import { COARSE_SIG_BYTES } from "../lib/tile-library"
import { directorySink } from "../lib/roboflow-sink"
import {
  COARSE_SIGNATURES_FILE,
  MANIFEST_FILE,
  newerStatus,
  roboflowThumbPath,
  snapshotDir,
} from "../lib/roboflow"
import type { PackManifest } from "../lib/roboflow-pack"
import { EvenSample, evenSampleIndices, planTileSample } from "../lib/roboflow-sample"
import {
  fetchImageDetails,
  fetchThumbnailBatch,
  listProjectImages,
  searchProjectImages,
  thumbUrlFromSource,
} from "../lib/roboflow-api"
import { MIN_PARTIAL_TILES } from "../lib/roboflow-limits"

// ─── Fixtures ────────────────────────────────────────────────────────────────

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

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "roboflow-ingest-test-"))
  try {
    return await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const silent = () => {}
const projectRef = { workspace: "workspace", project: "project", version: 1 }

type ApiImage = {
  id: string
  name: string
  bytes: Buffer
  broken?: boolean
}

async function makeImages(count: number): Promise<ApiImage[]> {
  const images: ApiImage[] = []
  for (let index = 0; index < count; index++) {
    images.push({
      id: `img-${String(index).padStart(4, "0")}`,
      name: `image-${String(index).padStart(4, "0")}.jpg`,
      bytes: await image(index),
    })
  }
  return images
}

function stubRoboflow(
  images: ApiImage[],
  options: {
    pageSize?: number
    failThumbTimes?: number
    failSearchTimes?: number
  } = {}
): {
  restore: () => void
  requested: string[]
} {
  const original = globalThis.fetch
  const pageSize = options.pageSize ?? 250
  const requested: string[] = []
  let remainingThumbFailures = options.failThumbTimes ?? 0
  let remainingSearchFailures = options.failSearchTimes ?? 0
  process.env.ROBOFLOW_API_KEY ??= "test-key"

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input)
    requested.push(url)
    if (url.includes("/search")) {
        if (remainingSearchFailures > 0) {
          remainingSearchFailures -= 1
          return new Response("try again", { status: 503 })
        }
        const body = init?.body ? JSON.parse(String(init.body)) : {}
        const offset = Number(body.offset ?? 0)
        const limit = Math.min(Number(body.limit ?? pageSize), pageSize)
        const slice = images.slice(offset, offset + limit)
        return Response.json({
          offset,
          total: images.length,
          results: slice.map((image) => ({
            id: image.id,
            name: image.name,
            url: `https://source.roboflow.com/owner/${image.id}/original.jpg`,
          })),
        })
      }

      const detail = /\/images\/([^/?]+)/.exec(url)
      if (detail && url.includes("api.roboflow.com")) {
        const id = decodeURIComponent(detail[1])
        const found = images.find((image) => image.id === id)
        if (!found) return new Response("missing", { status: 404 })
        return Response.json({
          image: {
            id: found.id,
            name: found.name,
            urls: {
              original: `https://source.roboflow.com/owner/${found.id}/original.jpg`,
              thumb: `https://source.roboflow.com/owner/${found.id}/thumb.jpg`,
            },
          },
        })
      }

      const thumb = /\/owner\/([^/]+)\/thumb\.jpg/.exec(url)
      if (thumb) {
        if (remainingThumbFailures > 0) {
          remainingThumbFailures -= 1
          return new Response("busy", { status: 429 })
        }
        const found = images.find((image) => image.id === thumb[1])
        if (!found) return new Response("missing", { status: 404 })
        if (found.broken) {
          return new Response("not an image at all", {
            headers: { "content-type": "text/plain" },
          })
        }
        return new Response(found.bytes as BodyInit, {
          headers: { "content-type": "image/jpeg" },
        })
      }

      if (url.includes("api.roboflow.com") && !url.includes("/search")) {
        return Response.json({
          project: { name: "Test Project", type: "object-detection" },
          versions: [{ id: "workspace/project/1", images: images.length }],
        })
      }

    return new Response("Not found", { status: 404 })
  }) as typeof globalThis.fetch

  return {
    restore: () => {
      globalThis.fetch = original
    },
    requested,
  }
}

type Library = {
  manifest: PackManifest
  signatures: Uint8Array
  thumb: (id: string) => Promise<Uint8Array | null>
}

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
  }
  assert.equal(library.manifest.version, version)
  const snap = snapshotDir(version)
  assert.equal(
    JSON.parse(await readFile(path.join(directory, snap, MANIFEST_FILE), "utf8"))
      .version,
    version
  )
  return library
}

// ─── API client ──────────────────────────────────────────────────────────────

test("search pages through a project and lists every image", async () => {
  const images = await makeImages(6)
  const stub = stubRoboflow(images, { pageSize: 2 })
  try {
    const first = await searchProjectImages(projectRef, { offset: 0, limit: 2 })
    assert.equal(first.total, 6)
    assert.equal(first.results.length, 2)
    const listed = await listProjectImages(projectRef)
    assert.equal(listed.total, 6)
    assert.deepEqual(
      listed.images.map((image) => image.id),
      images.map((image) => image.id)
    )
  } finally {
    stub.restore()
  }
})

test("a transient search failure is retried", async () => {
  const images = await makeImages(2)
  const stub = stubRoboflow(images, { failSearchTimes: 1 })
  try {
    const page = await searchProjectImages(projectRef)
    assert.equal(page.results.length, 2)
    assert.ok(stub.requested.filter((url) => url.includes("/search")).length >= 2)
  } finally {
    stub.restore()
  }
})

test("a page of thumbnails is requested together", async () => {
  const images = await makeImages(4)
  const stub = stubRoboflow(images)
  try {
    const batch = await fetchThumbnailBatch(
      projectRef,
      images.map(({ id, name }) => ({
        id,
        name,
        url: `https://source.roboflow.com/owner/${id}/original.jpg`,
      }))
    )
    assert.equal(batch.length, 4)
    assert.equal(batch.filter((item) => item.bytes).length, 4)
    const thumbs = stub.requested.filter((url) => url.includes("/thumb.jpg"))
    assert.equal(thumbs.length, 4)
    assert.deepEqual(
      thumbs.map((url) => /\/owner\/([^/]+)\//.exec(url)?.[1]).sort(),
      images.map((image) => image.id).sort()
    )
  } finally {
    stub.restore()
  }
})

test("image details expose original and thumb URLs", async () => {
  const images = await makeImages(1)
  const stub = stubRoboflow(images)
  try {
    const details = await fetchImageDetails(projectRef, images[0].id)
    assert.equal(details.id, images[0].id)
    assert.match(details.urls.thumb ?? "", /\/thumb\.jpg$/)
    assert.equal(
      thumbUrlFromSource(`https://source.roboflow.com/owner/${images[0].id}/original.jpg`),
      `https://source.roboflow.com/owner/${images[0].id}/thumb.jpg`
    )
  } finally {
    stub.restore()
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

test("the tile plan strides across the whole set, and shrinks for a deadline", () => {
  const entries = Array.from({ length: 1000 }, (_, index) => ({
    name: `image-${index}.jpg`,
    compressedSize: 15_000,
  }))

  const capped = planTileSample({ entries }, { budget: 100 })
  assert.equal(capped.length, 100)
  assert.equal(capped[0].name, "image-0.jpg")
  assert.equal(capped[99].name, "image-990.jpg")

  const rushed = planTileSample(
    { entries },
    { budget: 1000, msAvailable: 400, msPerItem: 40 }
  )
  assert.equal(rushed.length, 10)
  assert.equal(rushed[0].name, "image-0.jpg")

  const whole = planTileSample({ entries }, { budget: 1000, msAvailable: 60_000 })
  assert.equal(whole.length, 1000)
})

test("even sample indices match the tile plan's stride", () => {
  const wanted = evenSampleIndices(1000, 100)
  assert.equal(wanted.size, 100)
  assert.equal(wanted.has(0), true)
  assert.equal(wanted.has(990), true)
  assert.equal(wanted.has(1), false)
})

// ─── Seeding ─────────────────────────────────────────────────────────────────

test("a build turns project thumbnails into a library the browser can load", async () => {
  const images = await makeImages(9)
  const stub = stubRoboflow(images)
  try {
    await withTempDir(async (dir) => {
      const sink = await directorySink(dir)
      const snapshots: number[] = []
      const built = await buildLibraryFromImages(
        projectRef,
        images.map(({ id, name }) => ({ id, name })),
        sink,
        silent,
        {
          directory: dir,
          sourceImages: 9,
          onSnapshot: (snapshot) => {
            snapshots.push(snapshot.photoCount)
          },
        }
      )
      await sink.finish()

      assert.equal(built.photoCount, 9)
      assert.equal(built.skipped, 0)
      assert.equal(built.sampled, false)
      assert.equal(built.sourceImages, 9)
      assert.ok(snapshots.at(-1) === 9)

      const written = await readdir(dir)
      assert.ok(written.includes("manifest.json"))
      assert.ok(written.includes("signatures-coarse.bin"))
      assert.ok(written.includes("thumbs"))
      assert.ok(written.includes("snapshots"))

      const library = await readBuiltLibrary(dir, built.version)
      assert.equal(library.manifest.photos.length, 9)
      assert.equal(library.signatures.length, 9 * COARSE_SIG_BYTES)
      for (const photo of library.manifest.photos) {
        assert.ok(await library.thumb(photo.id), `no thumbnail for ${photo.id}`)
        assert.ok(photo.w > 0 && photo.h > 0)
      }
      assert.deepEqual(
        library.manifest.photos.map((photo) => photo.file),
        images.map((image) => image.name).sort()
      )
    })
  } finally {
    stub.restore()
  }
})

test("search pages seed their thumbnails as a batch", async () => {
  const images = await makeImages(6)
  const stub = stubRoboflow(images, { pageSize: 2 })
  try {
    await withTempDir(async (dir) => {
      const sink = await directorySink(dir)
      const built = await buildLibraryFromSearch(projectRef, sink, silent, {
        directory: dir,
      })
      await sink.finish()
      assert.equal(built.photoCount, 6)

      const thumbIds = stub.requested
        .map((url) => /\/owner\/([^/]+)\/thumb\.jpg/.exec(url)?.[1])
        .filter((id): id is string => Boolean(id))
      assert.deepEqual(thumbIds.slice(0, 2).sort(), ["img-0000", "img-0001"])
      assert.deepEqual(thumbIds.slice(2, 4).sort(), ["img-0002", "img-0003"])
      assert.deepEqual(thumbIds.slice(4, 6).sort(), ["img-0004", "img-0005"])
    })
  } finally {
    stub.restore()
  }
})

test("a dataset larger than the tile budget is sampled, not truncated", async () => {
  const images = await makeImages(12)
  const stub = stubRoboflow(images)
  try {
    await withTempDir(async (dir) => {
      const sink = await directorySink(dir)
      const selected = images.filter((_, index) => index % 3 === 0)
      const built = await buildLibraryFromImages(
        projectRef,
        selected.map(({ id, name }) => ({ id, name })),
        sink,
        silent,
        { directory: dir, budget: 4, sourceImages: 12 }
      )
      await sink.finish()

      assert.equal(built.photoCount, 4)
      assert.equal(built.sampled, true)
      assert.equal(built.sourceImages, 12)

      const library = await readBuiltLibrary(dir, built.version)
      assert.equal(library.manifest.photos.length, 4)
      const indices = library.manifest.photos.map((photo) =>
        Number(/image-(\d+)/.exec(photo.file ?? "")?.[1] ?? -1)
      )
      assert.ok(Math.max(...indices) >= 8, `sampled ${indices.join(", ")}`)
    })
  } finally {
    stub.restore()
  }
})

test("an unreadable image costs its own tile and nothing else", async () => {
  const images = await makeImages(5)
  images.push({
    id: "broken",
    name: "broken.jpg",
    bytes: Buffer.from("not an image at all"),
    broken: true,
  })
  const stub = stubRoboflow(images)
  try {
    await withTempDir(async (dir) => {
      const sink = await directorySink(dir)
      const built = await buildLibraryFromImages(
        projectRef,
        images.map(({ id, name }) => ({ id, name })),
        sink,
        silent,
        { directory: dir }
      )
      await sink.finish()
      assert.equal(built.photoCount, 5)
      assert.equal(built.skipped, 1)
    })
  } finally {
    stub.restore()
  }
})

test("a transient thumbnail failure is retried", async () => {
  const images = await makeImages(2)
  const stub = stubRoboflow(images, { failThumbTimes: 1 })
  try {
    await withTempDir(async (dir) => {
      const sink = await directorySink(dir)
      const built = await buildLibraryFromImages(
        projectRef,
        images.map(({ id, name }) => ({ id, name })),
        sink,
        silent,
        { directory: dir }
      )
      assert.equal(built.photoCount, 2)
    })
  } finally {
    stub.restore()
  }
})

test("snapshots are published at the minimum batch and the end", async () => {
  const images = await makeImages(MIN_PARTIAL_TILES + 4)
  const stub = stubRoboflow(images)
  try {
    await withTempDir(async (dir) => {
      const sink = await directorySink(dir)
      const snapshots: number[] = []
      const built = await buildLibraryFromImages(
        projectRef,
        images.map(({ id, name }) => ({ id, name })),
        sink,
        silent,
        {
          directory: dir,
          onSnapshot: (snapshot) => {
            snapshots.push(snapshot.photoCount)
          },
        }
      )
      assert.ok(snapshots[0] >= MIN_PARTIAL_TILES)
      assert.equal(snapshots.at(-1), built.photoCount)
      assert.ok(snapshots.length >= 2)
    })
  } finally {
    stub.restore()
  }
})

test("a deadline after a usable snapshot still publishes what it has", async () => {
  const images = await makeImages(MIN_PARTIAL_TILES + 8)
  const original = globalThis.fetch
  const inner = stubRoboflow(images)
  let thumbs = 0
  const wrapped = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input)
    if (url.includes("/thumb.jpg")) {
      thumbs += 1
      if (thumbs > MIN_PARTIAL_TILES) {
        const error = new Error("Aborted")
        error.name = "AbortError"
        throw error
      }
    }
    return wrapped(input, init)
  }) as typeof globalThis.fetch
  try {
    await withTempDir(async (dir) => {
      const sink = await directorySink(dir)
      const built = await buildLibraryFromImages(
        projectRef,
        images.map(({ id, name }) => ({ id, name })),
        sink,
        silent,
        { directory: dir, sourceImages: images.length }
      )
      assert.ok(built.photoCount >= MIN_PARTIAL_TILES)
      assert.ok(built.photoCount < images.length)
      const library = await readBuiltLibrary(dir, built.version)
      assert.equal(library.manifest.photos.length, built.photoCount)
    })
  } finally {
    inner.restore()
    globalThis.fetch = original
  }
})

test("a project with no images fails with a message about the project", async () => {
  const stub = stubRoboflow([])
  try {
    await withTempDir(async (dir) => {
      const sink = await directorySink(dir)
      await assert.rejects(
        buildLibraryFromImages(projectRef, [], sink, silent, {
          directory: dir,
        }),
        /none of the dataset's images/i
      )
    })
  } finally {
    stub.restore()
  }
})

// ─── Choosing a version ──────────────────────────────────────────────────────

function stubProjectInfo(
  versions: { version: number; images?: number }[]
): () => void {
  const original = globalThis.fetch
  process.env.ROBOFLOW_API_KEY ??= "test-key"
  globalThis.fetch = (async () =>
    Response.json({
      project: { name: "Beverage Containers", type: "object-detection" },
      versions: versions.map((entry) => ({
        id: `workspace/project/${entry.version}`,
        images: entry.images,
      })),
    })) as typeof globalThis.fetch
  return () => {
    globalThis.fetch = original
  }
}

test("an empty version is not what a project URL without a version means", async () => {
  const restore = stubProjectInfo([
    { version: 1, images: 6519 },
    { version: 3, images: 15645 },
    { version: 7, images: 0 },
    { version: 8, images: 0 },
  ])
  try {
    const resolved = await resolveDataset({ workspace: "workspace", project: "project", version: null })
    assert.equal(resolved.ref.version, 3)
    assert.equal(resolved.images, 15645)
  } finally {
    restore()
  }
})

test("a version asked for by name that holds nothing says so", async () => {
  const restore = stubProjectInfo([
    { version: 3, images: 15645 },
    { version: 8, images: 0 },
  ])
  try {
    await assert.rejects(
      resolveDataset({ workspace: "workspace", project: "project", version: 8 }),
      /Version 8 .* contains no images\. Versions with images: 3\./
    )
  } finally {
    restore()
  }
})

test("a version with no reported image count is still the latest", async () => {
  const restore = stubProjectInfo([{ version: 1, images: 10 }, { version: 2 }])
  try {
    const resolved = await resolveDataset({
      workspace: "workspace",
      project: "project",
      version: null,
    })
    assert.equal(resolved.ref.version, 2)
  } finally {
    restore()
  }
})

test("the newer of two status records wins, whichever side it came from", () => {
  const record = (state: "running" | "error", updatedAt: string) => ({
    slug: "workspace--dataset--v1",
    state,
    step: state === "error" ? "Failed" : "Seeding tiles",
    done: 0,
    total: 0,
    updatedAt,
  })
  const abandoned = record("running", "2026-08-13T07:30:00.000Z")
  const live = record("running", "2026-08-13T07:41:00.000Z")

  assert.equal(newerStatus(abandoned, live), live)
  assert.equal(newerStatus(live, abandoned), live)
  assert.equal(newerStatus(null, live), live)
  assert.equal(newerStatus(live, null), live)
  assert.equal(newerStatus(null, null), null)
})
