import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import {
  INGEST_RATE_LIMIT,
  INGEST_RATE_WINDOW_MS,
  RESOLVE_RATE_LIMIT_COUNT,
  GLOBAL_INGEST_RATE_LIMIT,
  nextRateRecord,
} from "../lib/roboflow-control"
import { acquirePack, releasePack } from "../lib/roboflow-pack"
import { newerStatus } from "../lib/roboflow"
import { MosaicEngine } from "../lib/mosaic-client"
import { buildMosaicGeometry } from "../lib/mosaic-geometry"

test("ingest rate windows allow four requests then throttle", () => {
  const now = Date.UTC(2026, 7, 12)
  let record: { count: number; resetAt: number } | null = null
  for (let count = 1; count <= INGEST_RATE_LIMIT; count++) {
    const next = nextRateRecord(record, now)
    record = next.record
    assert.equal(next.result.allowed, true)
    assert.equal(next.result.remaining, INGEST_RATE_LIMIT - count)
  }

  const blocked = nextRateRecord(record, now)
  assert.equal(blocked.result.allowed, false)
  assert.equal(blocked.record.count, INGEST_RATE_LIMIT)
  assert.equal(blocked.result.retryAfterSeconds, INGEST_RATE_WINDOW_MS / 1000)
})

test("expired rate windows reset instead of permanently blocking a client", () => {
  const now = 1_000_000
  const next = nextRateRecord(
    { count: INGEST_RATE_LIMIT, resetAt: now - 1 },
    now
  )
  assert.equal(next.result.allowed, true)
  assert.equal(next.record.count, 1)
  assert.equal(next.record.resetAt, now + INGEST_RATE_WINDOW_MS)
})

test("resolve allows more loads than the ingest window", () => {
  const now = Date.UTC(2026, 7, 13)
  let record: { count: number; resetAt: number } | null = null
  for (let count = 1; count <= RESOLVE_RATE_LIMIT_COUNT; count++) {
    const next = nextRateRecord(
      record,
      now,
      RESOLVE_RATE_LIMIT_COUNT,
      INGEST_RATE_WINDOW_MS
    )
    record = next.record
    assert.equal(next.result.allowed, true)
  }

  const blocked = nextRateRecord(
    record,
    now,
    RESOLVE_RATE_LIMIT_COUNT,
    INGEST_RATE_WINDOW_MS
  )
  assert.equal(blocked.result.allowed, false)
  assert.ok(RESOLVE_RATE_LIMIT_COUNT > INGEST_RATE_LIMIT)
})

test("the project-wide ingest window has a separate ceiling", () => {
  const now = 2_000_000
  const current = {
    count: GLOBAL_INGEST_RATE_LIMIT,
    resetAt: now + INGEST_RATE_WINDOW_MS,
  }
  const next = nextRateRecord(
    current,
    now,
    GLOBAL_INGEST_RATE_LIMIT,
    INGEST_RATE_WINDOW_MS
  )
  assert.equal(next.result.allowed, false)
  assert.equal(next.result.limit, GLOBAL_INGEST_RATE_LIMIT)
})

test("zoom geometry skips tiles whose image URL is not ready", () => {
  const geometry = buildMosaicGeometry({
    frameW: 100,
    frameH: 100,
    tileSize: 10,
    centers: new Float32Array([5, 5, 15, 5, 25, 5]),
    angles: new Float32Array([0, 0, 0]),
    assignment: new Int32Array([0, 1, 0]),
    tileIds: ["ready", "not-loaded"],
    resolveTile: (id) =>
      id === "ready"
        ? { url: "blob:ready", previewUrl: "blob:ready", title: id }
        : null,
  })

  assert.deepEqual(Array.from(geometry.t), [0, -1, 0])
  assert.equal(geometry.tiles.length, 1)
  assert.equal(geometry.tiles[0]?.url, "blob:ready")
})

// Serve the two files the loader is allowed to fetch, recording every request
// so a test can prove no thumbnail was downloaded.
function stubAssets(files: Record<string, Uint8Array>): {
  restore: () => void
  requested: string[]
} {
  const original = globalThis.fetch
  const requested: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : String(input)
    requested.push(url)
    const match = Object.entries(files).find(([name]) =>
      url.includes(`/${name}`)
    )
    if (!match) return new Response("Not found", { status: 404 })
    const body = match[1]
    return new Response(body as BodyInit, {
      headers: { "content-length": String(body.byteLength) },
    })
  }) as typeof globalThis.fetch
  return { restore: () => (globalThis.fetch = original), requested }
}

function manifestBytes(version: string, ids: string[]): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({ version, photos: ids.map((id) => ({ id, w: 20, h: 10 })) })
  )
}

test("the loader fetches only the manifest and signatures", async () => {
  const version = "2026-08-12T00:00:00.000Z"
  const ids = ["0123456789abcdef", "0123456789abcde0"]
  const stub = stubAssets({
    "manifest.json": manifestBytes(version, ids),
    "signatures-coarse.bin": new Uint8Array(ids.length * 384),
  })
  try {
    const slug = "workspace--only-two--v1"
    const pack = await acquirePack(slug, {
      expectedVersion: version,
      expectedPhotoCount: ids.length,
      hasIcon: true,
    })

    assert.equal(pack.manifest.photos.length, ids.length)
    assert.equal(pack.signatures.length, ids.length * 384)

    // The whole point: tiles are URLs, and no tile has been transferred.
    assert.equal(stub.requested.length, 2)
    assert.ok(!stub.requested.some((url) => url.includes("thumbs/")))
    assert.match(pack.thumbUrl(ids[0]) ?? "", /\/api\/roboflow\/asset\/.*thumbs/)
    assert.equal(pack.thumbUrl("ffffffffffffffff"), null)
    assert.match(pack.iconUrl ?? "", /icon\.jpg/)

    releasePack(slug)
  } finally {
    stub.restore()
  }
})

test("loader guards scale with the published photo count", async () => {
  const version = "2026-08-12T00:00:00.000Z"
  const ids = ["0123456789abcdef", "0123456789abcde0", "0123456789abcde1"]

  // A signature blob far larger than one photo warrants is rejected as corrupt,
  // sized against the count the ingest reported rather than a fixed ceiling.
  const oversized = stubAssets({
    "manifest.json": manifestBytes(version, [ids[0]]),
    "signatures-coarse.bin": new Uint8Array(256 * 1024),
  })
  try {
    await assert.rejects(
      acquirePack("workspace--oversized--v1", {
        expectedVersion: version,
        expectedPhotoCount: 1,
      }),
      /unexpectedly large/
    )
  } finally {
    oversized.restore()
  }

  // A manifest declaring far more photos than the dataset should hold is corrupt.
  const tooMany = stubAssets({
    "manifest.json": manifestBytes(version, ids),
    "signatures-coarse.bin": new Uint8Array(ids.length * 384),
  })
  try {
    await assert.rejects(
      acquirePack("workspace--too-many--v1", {
        expectedVersion: version,
        expectedPhotoCount: 1,
      }),
      /manifest is invalid/
    )
  } finally {
    tooMany.restore()
  }

  // The same files load cleanly once the expected count matches them, proving a
  // large but legitimate library is not mistaken for a corrupt one.
  const legit = stubAssets({
    "manifest.json": manifestBytes(version, ids),
    "signatures-coarse.bin": new Uint8Array(ids.length * 384),
  })
  try {
    const slug = "workspace--legit--v1"
    const pack = await acquirePack(slug, {
      expectedVersion: version,
      expectedPhotoCount: ids.length,
    })
    assert.equal(pack.manifest.photos.length, ids.length)
    releasePack(slug)
  } finally {
    legit.restore()
  }
})

test("a re-ingested library is reported as stale rather than mixed in", async () => {
  const stub = stubAssets({
    "manifest.json": manifestBytes("2026-08-12T00:00:00.000Z", [
      "0123456789abcdef",
    ]),
    "signatures-coarse.bin": new Uint8Array(384),
  })
  try {
    await assert.rejects(
      acquirePack("workspace--stale--v1", {
        expectedVersion: "2026-08-13T00:00:00.000Z",
        expectedPhotoCount: 1,
      }),
      /re-ingested/
    )
  } finally {
    stub.restore()
  }
})

test("status progress writes are serialized", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "roboflow-status-test-"))
  process.env.ROBOFLOW_CACHE_DIR = root
  try {
    const store = await import("../lib/roboflow-store")
    const errors: unknown[] = []
    const writer = store.progressWriter("workspace--dataset--v1", {
      onError: (error) => errors.push(error),
    })
    for (let index = 0; index < 100; index++) {
      writer.report(`Step ${index}`, index, 100)
    }
    await writer.finish("ready", {})
    assert.deepEqual(errors, [])
    const raw = await readFile(
      path.join(root, "workspace--dataset--v1", "status.json"),
      "utf8"
    )
    assert.equal(JSON.parse(raw).state, "ready")
  } finally {
    delete process.env.ROBOFLOW_CACHE_DIR
    await rm(root, { recursive: true, force: true })
  }
})

// A poll can see two records of the same ingest: the file in this instance's
// /tmp and the durable copy every instance writes. The local one is not the
// truth — /tmp is never cleaned, so an instance keeps every attempt it ever
// started, and reading a dead attempt over a live run is what made a poll
// report "The ingest stopped unexpectedly" while the ingest went on to finish.
test("the newer of two status records wins, whichever side it came from", () => {
  const record = (state: "running" | "error", updatedAt: string) => ({
    slug: "workspace--dataset--v1",
    state,
    step: state === "error" ? "Failed" : "Building tiles",
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

test("hydrate can append unseen tiles without replacing the library", async () => {
  const messages: { type: string; append?: boolean; items: { id: string }[] }[] =
    []
  class RecordingWorker {
    onmessage: ((event: MessageEvent) => void) | null = null
    onerror: ((event: ErrorEvent) => void) | null = null
    onmessageerror: ((event: MessageEvent) => void) | null = null
    postMessage(message: { type: string; append?: boolean; items: { id: string }[] }) {
      messages.push(message)
    }
    terminate() {}
  }

  const item = (id: string) => ({
    id,
    sig: new Uint8Array(384),
    w: 16,
    h: 16,
    url: `https://example.test/${id}.jpg`,
  })
  const engine = new MosaicEngine(new RecordingWorker() as unknown as Worker)
  engine.hydrate([item("aaaaaaaaaaaaaaaa")])
  engine.hydrate([item("bbbbbbbbbbbbbbbb")], { append: true })
  assert.equal(messages[0]?.append, undefined)
  assert.equal(messages[1]?.append, true)
  assert.deepEqual(
    messages.map((message) => message.items.map((entry) => entry.id)),
    [["aaaaaaaaaaaaaaaa"], ["bbbbbbbbbbbbbbbb"]]
  )
  engine.terminate()
})

test("a running snapshot is remembered on later progress writes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "roboflow-snapshot-test-"))
  process.env.ROBOFLOW_CACHE_DIR = root
  try {
    const store = await import("../lib/roboflow-store")
    const writer = store.progressWriter("workspace--snapshot--v1")
    writer.report("Seeding tiles", 10, 40)
    await writer.snapshot({
      workspace: "workspace",
      project: "snapshot",
      version: 1,
      slug: "workspace--snapshot--v1",
      name: "Dataset",
      imageCount: 32,
      sourceImages: 80,
      universeUrl: "https://universe.roboflow.com/workspace/snapshot/dataset/1",
      libraryVersion: "2026-08-13T00:00:00.000Z",
    })
    writer.report("Seeding tiles", 20, 40)
    await writer.finish("error", { error: "later failure" })
    const status = await store.readStatus("workspace--snapshot--v1")
    assert.equal(status?.state, "error")
    assert.equal(status?.error, "later failure")
    assert.equal(status?.dataset?.imageCount, 32)
    assert.equal(status?.dataset?.libraryVersion, "2026-08-13T00:00:00.000Z")
  } finally {
    delete process.env.ROBOFLOW_CACHE_DIR
    await rm(root, { recursive: true, force: true })
  }
})

test("loader treats each snapshot version as its own pack", async () => {
  const first = manifestBytes("2026-08-12T00:00:00.000Z", ["0123456789abcdef"])
  const second = manifestBytes("2026-08-13T00:00:00.000Z", [
    "0123456789abcdef",
    "0123456789abcde0",
  ])
  const files: Record<string, Uint8Array> = {
    "manifest.json": first,
    "signatures-coarse.bin": new Uint8Array(384),
  }
  const stub = stubAssets(files)
  try {
    const slug = "workspace--growing--v1"
    const pack1 = await acquirePack(slug, {
      expectedVersion: "2026-08-12T00:00:00.000Z",
      expectedPhotoCount: 1,
    })
    assert.equal(pack1.manifest.photos.length, 1)
    files["manifest.json"] = second
    files["signatures-coarse.bin"] = new Uint8Array(768)
    const pack2 = await acquirePack(slug, {
      expectedVersion: "2026-08-13T00:00:00.000Z",
      expectedPhotoCount: 2,
    })
    assert.equal(pack2.manifest.photos.length, 2)
    assert.notEqual(pack1.version, pack2.version)
    releasePack(slug)
  } finally {
    stub.restore()
  }
})

test("worker request errors reject generation instead of hanging", async () => {
  class ErrorWorker {
    onmessage: ((event: MessageEvent) => void) | null = null
    onerror: ((event: ErrorEvent) => void) | null = null
    onmessageerror: ((event: MessageEvent) => void) | null = null
    postMessage(message: { reqId: number }) {
      queueMicrotask(() => {
        this.onmessage?.({
          data: {
            type: "error",
            reqId: message.reqId,
            message: "synthetic worker failure",
          },
        } as MessageEvent)
      })
    }
    terminate() {}
  }

  const engine = new MosaicEngine(new ErrorWorker() as unknown as Worker)
  await assert.rejects(
    engine.generate(
      [],
      { rows: 0, cols: 0 },
      [],
      new Float32Array(),
      new Float32Array(),
      new Int32Array([0]),
      1,
      1
    ),
    /synthetic worker failure/
  )
  engine.terminate()
})
