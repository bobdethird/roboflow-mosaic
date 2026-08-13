import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import { strToU8, zipSync } from "fflate"

import {
  INGEST_RATE_LIMIT,
  INGEST_RATE_WINDOW_MS,
  GLOBAL_INGEST_RATE_LIMIT,
  nextRateRecord,
} from "../lib/roboflow-control"
import {
  MAX_PACK_BYTES,
  storageLimitMessage,
} from "../lib/roboflow-limits"
import { unpackArchive } from "../lib/roboflow-pack"
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

test("deployment limits stay mutually compatible", () => {
  assert.equal(MAX_PACK_BYTES, 128 * 1024 * 1024)
  assert.match(storageLimitMessage("export", 320 * 1024 * 1024), /320 MB/)
  assert.match(storageLimitMessage("library", 128 * 1024 * 1024), /128 MB/)
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

test("streaming pack parser accepts tiny chunks and verifies versions", async () => {
  const id = "0123456789abcdef"
  const version = "2026-08-12T00:00:00.000Z"
  const archive = zipSync({
    "manifest.json": strToU8(
      JSON.stringify({ version, photos: [{ id, w: 20, h: 10 }] })
    ),
    "signatures-coarse.bin": new Uint8Array(384),
    [`thumbs/${id}.jpg`]: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
  })
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < archive.length; offset += 7) {
        controller.enqueue(archive.subarray(offset, offset + 7))
      }
      controller.close()
    },
  })
  const pack = await unpackArchive("workspace--dataset--v1", stream, {
    expectedVersion: version,
  })
  assert.equal(pack.manifest.photos.length, 1)
  assert.equal(pack.signatures.length, 384)
  assert.match(pack.thumbUrl(id) ?? "", /^blob:/)
  pack.release()

  await assert.rejects(
    unpackArchive(
      "workspace--dataset--v1",
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(archive)
          controller.close()
        },
      }),
      { expectedVersion: "stale-version" }
    ),
    /stale/
  )
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
