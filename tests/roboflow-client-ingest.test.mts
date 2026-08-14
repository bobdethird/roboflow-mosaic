import assert from "node:assert/strict"
import test from "node:test"

import { packCoarseSignature, SIG_GRID } from "../lib/roboflow-signature"
import { isAllowedImageUrl } from "../lib/roboflow-proxy"
import { evenSampleIndices } from "../lib/roboflow-sample"
import { COARSE_SIG_BYTES } from "../lib/tile-library"

test("packCoarseSignature averages each 2×2 block into a uint16 LE sum", () => {
  const sig = new Uint8Array(SIG_GRID * SIG_GRID * 3)
  // Top-left 2×2 of red = 10, so the stored sum is 40.
  for (const [x, y] of [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ] as const) {
    sig[(y * SIG_GRID + x) * 3] = 10
  }
  const packed = packCoarseSignature(sig)
  assert.equal(packed.byteLength, COARSE_SIG_BYTES)
  assert.equal(new DataView(packed.buffer).getUint16(0, true), 40)
  assert.equal(new DataView(packed.buffer).getUint16(2, true), 0)
})

test("thumb proxy only accepts https URLs on known image hosts", () => {
  assert.equal(
    isAllowedImageUrl("https://source.roboflow.com/owner/img/thumb.jpg"),
    true
  )
  assert.equal(
    isAllowedImageUrl("https://storage.googleapis.com/bucket/thumb.jpg"),
    true
  )
  assert.equal(isAllowedImageUrl("http://source.roboflow.com/thumb.jpg"), false)
  assert.equal(isAllowedImageUrl("https://evil.example/thumb.jpg"), false)
  assert.equal(isAllowedImageUrl("not-a-url"), false)
})

test("client sample still spreads across the whole project", () => {
  const wanted = evenSampleIndices(1000, 20)
  assert.equal(wanted.size, 20)
  assert.ok(wanted.has(0))
  assert.ok(wanted.has(950) || wanted.has(Math.floor((19 * 1000) / 20)))
})
